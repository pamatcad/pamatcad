use crate::{
    error::{CoreError, ErrorCode, Result},
    kernel::Shape,
    protocol::*,
    sketch::Sketch,
};
use std::collections::BTreeMap;

pub struct Body {
    pub reference: BodyRef,
    pub shape: Shape,
}

pub struct StoredFeature {
    pub data: Feature,
    pub faces_by_body: BTreeMap<String, Vec<(usize, std::ops::Range<usize>)>>,
}

pub struct Scene {
    pub data: SceneData,
    pub sketches: BTreeMap<String, Sketch>,
    pub bodies: BTreeMap<String, Body>,
    pub timeline: Vec<TimelineEntry>,
    pub features: BTreeMap<String, StoredFeature>,
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
        }
    }

    pub fn has_plane(&self, plane: &PlaneRef) -> bool {
        let planes = &self.data.construction.builtin.planes;
        [&planes.xy, &planes.xz, &planes.yz].contains(&plane)
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
        let body = self.bodies.get(body_id).ok_or_else(|| {
            CoreError::new(ErrorCode::NotFound, "Body does not exist in this scene")
        })?;
        let slot = match face {
            FaceRef::Selected { face_id, .. } => *face_id,
            FaceRef::Origin { origin, .. } => {
                if !self
                    .features
                    .get(&origin.feature)
                    .is_some_and(|feature| feature.data.new_solids.contains(&body.reference))
                {
                    return Err(CoreError::new(
                        ErrorCode::NotFound,
                        "This feature did not create the selected body",
                    ));
                }
                match origin.role {
                    FaceRole::EndCap => 0,
                }
            }
        };
        Ok((body, slot))
    }
}
