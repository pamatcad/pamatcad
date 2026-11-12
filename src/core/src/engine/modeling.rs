use super::Engine;
use crate::{
    error::Result,
    kernel::Shape,
    model::{Body, Scene},
    protocol::{
        BodyProperties, BodyRef, Feature, FeaturePreview, FeatureResult, Operation, Volume,
        VolumeUnit,
    },
};

pub(crate) trait ModelingCommand {
    fn scene_id(&self) -> Result<&str>;
    fn evaluate(self, scene: &Scene) -> Result<ProposedChanges>;
}

pub(crate) struct ProposedChanges {
    pub operation: Operation,
    pub created: Vec<Shape>,
    pub changed: Vec<Body>,
}

impl ProposedChanges {
    fn affected_solids(&self) -> Vec<BodyRef> {
        self.changed
            .iter()
            .map(|body| body.reference.clone())
            .collect()
    }

    fn preview(self) -> Result<FeaturePreview> {
        let affected_solids = self.affected_solids();
        let new_solids = self
            .created
            .iter()
            .map(|shape| {
                Ok(BodyProperties {
                    volume: Volume {
                        value: shape.volume()?,
                        unit: VolumeUnit::CubicMillimetres,
                    },
                })
            })
            .collect::<Result<_>>()?;
        Ok(FeaturePreview {
            operation: self.operation,
            new_solids,
            affected_solids,
        })
    }
}

impl Engine {
    pub(super) fn execute_modeling(
        &mut self,
        preview: bool,
        command: impl ModelingCommand,
    ) -> Result<FeatureResult> {
        let scene_id = command.scene_id()?.to_owned();
        let changes = command.evaluate(self.scene(&scene_id)?)?;
        if preview {
            return changes.preview().map(FeatureResult::Preview);
        }
        Ok(FeatureResult::Feature(
            self.commit_changes(scene_id, changes),
        ))
    }

    // Evaluation has validated every proposed body before IDs are assigned or the scene is updated.
    fn commit_changes(&mut self, scene_id: String, changes: ProposedChanges) -> Feature {
        let affected_solids = changes.affected_solids();
        let mut bodies = changes.changed;
        let mut new_solids = Vec::with_capacity(changes.created.len());
        for shape in changes.created {
            let reference = BodyRef {
                scene_id: scene_id.clone(),
                id: self.id("body"),
            };
            new_solids.push(reference.clone());
            bodies.push(Body { reference, shape });
        }
        let feature = Feature {
            id: self.id("feature"),
            operation: changes.operation,
            new_solids,
            affected_solids,
        };
        let scene = self.scenes.get_mut(&scene_id).unwrap();
        let mut faces_by_body = std::collections::BTreeMap::new();
        for mut body in bodies {
            faces_by_body.insert(
                body.reference.id.clone(),
                std::mem::take(&mut body.shape.profile_slots),
            );
            scene.bodies.insert(body.reference.id.clone(), body);
        }
        scene.timeline.push(feature.timeline_entry());
        scene.features.insert(
            feature.id.clone(),
            crate::model::StoredFeature {
                data: feature.clone(),
                faces_by_body,
            },
        );
        feature
    }
}
