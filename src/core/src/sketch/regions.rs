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
pub(super) struct Cached {
    key: Vec<u8>,
    regions: Vec<Region>,
}
pub fn evaluate(sketch: &Sketch) -> Result<Vec<Region>> {
    let key = crate::kernel::sketch::geometry_key(sketch, None)?;
    if let Some(cached) = sketch
        .region_cache
        .borrow()
        .as_ref()
        .filter(|c| c.key == key)
    {
        return Ok(cached.regions.clone());
    }
    let profiles = crate::kernel::sketch::regions(sketch)?;
    let mut ids = std::collections::BTreeSet::new();
    let regions = profiles
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
        .collect::<Result<Vec<_>>>()?;
    *sketch.region_cache.borrow_mut() = Some(std::rc::Rc::new(Cached {
        key,
        regions: regions.clone(),
    }));
    Ok(regions)
}
