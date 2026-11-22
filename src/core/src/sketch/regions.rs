use super::Sketch;
use crate::{
    error::{CoreError, ErrorCode, Result},
    kernel::sketch::Profile,
    protocol::RegionRef,
};
#[derive(Clone)]
pub struct Region {
    pub reference: RegionRef,
    pub boundary: Boundary,
}
#[derive(Clone)]
pub enum Boundary {
    Profile(Profile),
}
pub fn evaluate(sketch: &Sketch) -> Result<Vec<Region>> {
    let profiles = crate::kernel::sketch::regions(sketch)?;
    let mut ids = std::collections::BTreeSet::new();
    profiles
        .into_iter()
        .map(|profile| {
            let id = format!("region/{}", profile.signature);
            if !ids.insert(id.clone()) {
                return Err(CoreError::new(
                    ErrorCode::AmbiguousRegion,
                    "Multiple regions have indistinguishable source boundaries",
                ));
            }
            Ok(Region {
                reference: RegionRef {
                    scene_id: sketch.data.scene_id.clone(),
                    sketch_id: sketch.data.id.clone(),
                    id,
                },
                boundary: Boundary::Profile(profile),
            })
        })
        .collect()
}
