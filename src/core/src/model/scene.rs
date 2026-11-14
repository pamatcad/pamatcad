use crate::{
    error::{CoreError, ErrorCode, Result},
    kernel::Shape,
    protocol::*,
    sketch::Sketch,
};
use std::{collections::BTreeMap, ops::Range};

pub struct Body {
    pub reference: BodyRef,
    pub shape: Shape,
    pub created_at: u64,
}

pub struct StoredFeature {
    pub data: Feature,
    pub faces_by_body: BTreeMap<String, Vec<(usize, Range<usize>)>>,
}

pub struct Scene {
    pub data: SceneData,
    pub sketches: BTreeMap<String, Sketch>,
    pub bodies: BTreeMap<String, Body>,
    pub timeline: Vec<TimelineEntry>,
    pub features: BTreeMap<String, StoredFeature>,
    // An absorbed body's face slots occupy this range on its successor.
    pub face_successors: BTreeMap<String, (String, Range<usize>)>,
}

impl Scene {
    pub fn new(id: String, name: Option<String>) -> Self {
        let plane = |plane, name| PlaneRef {
            scene_id: id.clone(),
            id: format!("{id}:origin:{name}"),
            plane,
        };
        let planes = Planes {
            xy: plane(Plane::Xy, "xy"),
            xz: plane(Plane::Xz, "xz"),
            yz: plane(Plane::Yz, "yz"),
        };
        Self {
            data: SceneData {
                id,
                name,
                construction: Construction {
                    builtin: BuiltinConstruction { planes },
                },
            },
            sketches: BTreeMap::new(),
            bodies: BTreeMap::new(),
            timeline: Vec::new(),
            features: BTreeMap::new(),
            face_successors: BTreeMap::new(),
        }
    }

    pub fn has_plane(&self, plane: &PlaneRef) -> bool {
        let planes = &self.data.construction.builtin.planes;
        [&planes.xy, &planes.xz, &planes.yz].contains(&plane)
    }

    pub(crate) fn face_owner(&self, original: &str) -> Option<(&Body, Range<usize>)> {
        let mut id = original;
        let mut offset = 0;
        let first = self.face_successors.get(original);
        while let Some((next, slots)) = self.face_successors.get(id) {
            id = next;
            offset += slots.start;
        }
        let body = self.bodies.get(id)?;
        let count = first.map_or_else(|| body.shape.slot_count(), |(_, slots)| slots.len());
        Some((body, offset..offset + count))
    }

    pub(crate) fn resolve_face(&self, face: &FaceRef) -> Result<(&Body, usize)> {
        if face.scene_id() != self.data.id {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Face belongs to another scene",
            ));
        }
        let body_id = match face {
            FaceRef::Origin { body_id, .. } | FaceRef::Selected { body_id, .. } => body_id,
        };
        let (body, slots) = self.face_owner(body_id).ok_or_else(|| {
            CoreError::new(ErrorCode::NotFound, "Body does not exist in this scene")
        })?;
        let slot =
            match face {
                FaceRef::Selected { face_id, .. } => *face_id,
                FaceRef::Origin { origin, .. } => {
                    if !self.features.get(&origin.feature).is_some_and(|feature| {
                        feature.data.new_solids.iter().any(|r| &r.id == body_id)
                    }) {
                        return Err(CoreError::new(
                            ErrorCode::NotFound,
                            "This feature did not create the selected body",
                        ));
                    }
                    match origin.role {
                        FaceRole::EndCap | FaceRole::EndCap1 => 0,
                    }
                }
            };
        if slot >= slots.len() {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                "Face does not exist on this body",
            ));
        }
        Ok((body, slots.start + slot))
    }
}
