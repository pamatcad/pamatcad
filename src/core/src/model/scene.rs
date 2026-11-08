use crate::{kernel::Shape, protocol::*, sketch::Sketch};
use std::collections::BTreeMap;

pub struct Body {
    pub reference: BodyRef,
    pub shape: Shape,
}

pub struct Scene {
    pub data: SceneData,
    pub sketches: BTreeMap<String, Sketch>,
    pub bodies: BTreeMap<String, Body>,
    pub timeline: Vec<TimelineEntry>,
    pub features: BTreeMap<String, Feature>,
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
}
