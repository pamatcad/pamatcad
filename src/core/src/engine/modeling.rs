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

pub(crate) struct BodyUpdate {
    pub body: Body,
    pub material_changed: bool,
    pub absorbed_slots: Vec<(String, std::ops::Range<usize>)>,
}

pub(crate) struct ProposedChanges {
    pub operation: Operation,
    pub created: Vec<Shape>,
    pub updated: Vec<BodyUpdate>,
    pub removed: Vec<BodyRef>,
}

impl ProposedChanges {
    fn affected_solids(&self) -> Vec<BodyRef> {
        self.updated
            .iter()
            .filter(|update| update.material_changed)
            .map(|update| update.body.reference.clone())
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
            removed_solids: self.removed,
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
        let mut bodies = Vec::new();
        let mut new_solids = Vec::with_capacity(changes.created.len());
        for shape in changes.created {
            let reference = BodyRef {
                scene_id: scene_id.clone(),
                id: self.id("body"),
            };
            new_solids.push(reference.clone());
            bodies.push(Body {
                reference,
                shape,
                created_at: self.next_id,
            });
        }
        let feature = Feature {
            id: self.id("feature"),
            operation: changes.operation,
            new_solids,
            affected_solids,
            removed_solids: changes.removed,
        };
        let scene = self.scenes.get_mut(&scene_id).unwrap();
        for removed in &feature.removed_solids {
            scene.bodies.remove(&removed.id);
        }
        for update in changes.updated {
            for (id, slots) in update.absorbed_slots {
                scene
                    .face_successors
                    .insert(id, (update.body.reference.id.clone(), slots));
            }
            bodies.push(update.body);
        }
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
