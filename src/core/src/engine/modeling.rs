use super::Engine;
use crate::{
    error::{CoreError, ErrorCode, Result},
    kernel::Shape,
    model::{Body, Scene},
    protocol::{
        BodyProperties, BodyProxy, BodyRef, Feature, FeaturePreview, FeatureResult,
        ModelingRequest, Operation, ProxyQuery, Volume, VolumeUnit,
    },
};

use std::collections::BTreeMap;

pub(super) struct PreviewOverlay {
    revision: String,
    shapes: BTreeMap<String, Shape>,
}

pub(crate) trait ModelingCommand {
    fn scene_id(&self) -> Result<&str>;
    fn evaluate(self, scene: &Scene) -> Result<ProposedChanges>;
}

pub(crate) struct BodyUpdate {
    pub body: Body,
    pub material_changed: bool,
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

    fn preview(self, scene: &str, revision: String) -> Result<(FeaturePreview, PreviewOverlay)> {
        let affected_solids = self.affected_solids();
        let mut shapes = BTreeMap::new();
        let mut new_solids = Vec::with_capacity(self.created.len());
        let mut new_solid_properties = Vec::with_capacity(self.created.len());
        for (index, shape) in self.created.into_iter().enumerate() {
            let id = format!("preview-{revision}-{index}");
            new_solid_properties.push(BodyProperties {
                volume: Volume {
                    value: shape.volume()?,
                    unit: VolumeUnit::CubicMillimetres,
                },
            });
            new_solids.push(BodyRef {
                scene_id: scene.to_owned(),
                id: id.clone(),
            });
            shapes.insert(id, shape);
        }
        for update in self
            .updated
            .into_iter()
            .filter(|update| update.material_changed)
        {
            shapes.insert(update.body.reference.id, update.body.shape);
        }
        let result = FeaturePreview {
            operation: self.operation,
            revision: revision.clone(),
            new_solids,
            new_solid_properties,
            affected_solids,
            removed_solids: self.removed,
        };
        Ok((result, PreviewOverlay { revision, shapes }))
    }
}

impl Engine {
    pub(super) fn proxy_for(&self, session: u64, query: ProxyQuery) -> Result<BodyProxy> {
        let (shape, revision) = if query.preview.unwrap_or(false) {
            let overlay = self.previews.get(&(session, query.body.scene_id.clone()));
            let (overlay, shape) = overlay
                .and_then(|p| p.shapes.get(&query.body.id).map(|s| (p, s)))
                .ok_or_else(|| {
                    CoreError::new(
                        ErrorCode::PreviewUnavailable,
                        "No cached preview B-rep for this body",
                    )
                })?;
            (shape, overlay.revision.clone())
        } else {
            let body = self.body(&query.body)?;
            (&body.shape, body.revision.to_string())
        };
        if query
            .revision
            .as_ref()
            .is_some_and(|expected| expected != &revision)
        {
            return Err(CoreError::new(
                ErrorCode::InvalidState,
                "Geometry revision has changed",
            ));
        }
        shape.proxy(query.body, revision)
    }

    pub(super) fn execute_modeling<C: ModelingCommand>(
        &mut self,
        session: u64,
        request: ModelingRequest<C>,
    ) -> Result<FeatureResult> {
        let scene_id = request.command.scene_id()?.to_owned();
        let preview = request.preview.unwrap_or(false);
        if preview {
            self.previews.remove(&(session, scene_id.clone()));
        }
        let changes = request.command.evaluate(self.scene(&scene_id)?)?;
        self.next_revision += 1;
        if preview {
            let (result, overlay) = changes.preview(&scene_id, self.next_revision.to_string())?;
            self.previews.insert((session, scene_id), overlay);
            return Ok(FeatureResult::Preview(result));
        }
        self.invalidate_previews(&scene_id);
        Ok(FeatureResult::Feature(
            self.commit_changes(scene_id, changes),
        ))
    }

    // Evaluation has validated every proposed body before IDs are assigned or the scene is updated.
    fn commit_changes(&mut self, scene_id: String, changes: ProposedChanges) -> Feature {
        self.commit_recomputed(scene_id, changes, None)
    }

    pub(super) fn commit_recomputed(
        &mut self,
        scene_id: String,
        changes: ProposedChanges,
        previous: Option<&Feature>,
    ) -> Feature {
        let affected_solids = changes.affected_solids();
        let mut bodies = Vec::new();
        let mut new_solids = Vec::with_capacity(changes.created.len());
        for (index, shape) in changes.created.into_iter().enumerate() {
            let reference = BodyRef {
                scene_id: scene_id.clone(),
                id: previous
                    .and_then(|f| f.new_solids.get(index))
                    .map(|b| b.id.clone())
                    .unwrap_or_else(|| self.id("body")),
            };
            new_solids.push(reference.clone());
            bodies.push(Body {
                reference: reference.clone(),
                shape,
                created_at: reference
                    .id
                    .rsplit('-')
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(self.next_id),
                revision: self.next_revision,
            });
        }
        let feature = Feature {
            id: previous
                .map(|f| f.id.clone())
                .unwrap_or_else(|| self.id("feature")),
            operation: changes.operation,
            new_solids,
            affected_solids,
            removed_solids: changes.removed,
        };
        let scene = self.scenes.get_mut(&scene_id).unwrap();
        bodies.extend(changes.updated.into_iter().map(|update| update.body));
        let mut remapped = BTreeMap::<(String, usize), Vec<(String, usize)>>::new();
        for removed in &feature.removed_solids {
            for slot in 0..scene.bodies[&removed.id].shape.slot_count() {
                remapped.insert((removed.id.clone(), slot), Vec::new());
            }
        }
        for body in &mut bodies {
            for (source, faces) in std::mem::take(&mut body.shape.inherited_faces) {
                remapped.entry(source).or_default().extend(
                    faces
                        .into_iter()
                        .map(|slot| (body.reference.id.clone(), slot)),
                );
            }
        }
        // Keep the history flattened: split/rejoin chains must not form cycles when
        // a surviving body ID is reused. Each entry points directly at current faces.
        for descendants in scene.face_successors.values_mut() {
            *descendants = descendants
                .iter()
                .flat_map(|face| {
                    remapped
                        .get(face)
                        .cloned()
                        .unwrap_or_else(|| vec![face.clone()])
                })
                .collect();
            descendants.sort();
            descendants.dedup();
        }
        for (source, mut descendants) in remapped {
            descendants.sort();
            descendants.dedup();
            scene.face_successors.entry(source).or_insert(descendants);
        }
        for removed in &feature.removed_solids {
            scene.bodies.remove(&removed.id);
        }
        let mut faces_by_body = std::collections::BTreeMap::new();
        for mut body in bodies {
            body.revision = self.next_revision;
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
