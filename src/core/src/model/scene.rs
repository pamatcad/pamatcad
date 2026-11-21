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
    pub revision: u64,
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
    // Historical body/slot pairs resolve directly to distinct current descendants.
    pub face_successors: BTreeMap<(String, usize), Vec<(String, usize)>>,
}

impl Scene {
    pub fn new(id: String, name: Option<String>, units: SceneUnits) -> Self {
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
                units,
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

    pub(crate) fn face_descendants(
        &self,
        original: &str,
        slots: Range<usize>,
    ) -> Result<Vec<(&Body, usize)>> {
        let mut faces = std::collections::BTreeSet::new();
        for slot in slots {
            if let Some(descendants) = self.face_successors.get(&(original.to_owned(), slot)) {
                faces.extend(descendants.iter().cloned());
            } else if let Some(body) = self.bodies.get(original) {
                if slot < body.shape.slot_count() {
                    faces.extend(
                        body.shape
                            .face_ids(Some(slot..slot + 1))?
                            .into_iter()
                            .map(|id| (original.to_owned(), id)),
                    );
                }
            }
        }
        Ok(faces
            .into_iter()
            .filter_map(|(id, slot)| self.bodies.get(&id).map(|body| (body, slot)))
            .collect())
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
        let slots = match face {
            FaceRef::Selected { face_id, .. } => vec![*face_id],
            FaceRef::Origin { origin, .. } => {
                let feature = self
                    .features
                    .get(&origin.feature)
                    .filter(|feature| feature.data.new_solids.iter().any(|r| &r.id == body_id))
                    .ok_or_else(|| {
                        CoreError::new(
                            ErrorCode::NotFound,
                            "This feature did not create the selected body",
                        )
                    })?;
                feature
                    .faces_by_body
                    .get(body_id)
                    .into_iter()
                    .flatten()
                    .map(|(_, range)| match origin.role {
                        FaceRole::EndCap1 => range.start,
                    })
                    .collect()
            }
        };
        let mut faces = Vec::new();
        for slot in slots {
            faces.extend(self.face_descendants(body_id, slot..slot.saturating_add(1))?);
        }
        faces.sort_by(|(a, i), (b, j)| (&a.reference.id, i).cmp(&(&b.reference.id, j)));
        faces.dedup_by(|(a, i), (b, j)| a.reference.id == b.reference.id && i == j);
        match faces.as_slice() {
            [face] => Ok(*face),
            [] => Err(CoreError::new(ErrorCode::NotFound, "No matching face")),
            _ => Err(CoreError::new(
                ErrorCode::AmbiguousFace,
                "Multiple matching faces",
            )),
        }
    }
}
