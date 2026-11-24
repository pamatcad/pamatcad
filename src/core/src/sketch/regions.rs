use super::Sketch;
use crate::{
    error::{CoreError, ErrorCode, Result},
    kernel::sketch::Profile,
    protocol::RegionRef,
};
use std::{collections::BTreeMap, rc::Rc};
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
    groups: BTreeMap<Vec<u8>, Rc<Vec<Profile>>>,
}
pub fn evaluate(sketch: &Sketch) -> Result<Vec<Region>> {
    let key = crate::kernel::sketch::geometry_key(sketch, None)?;
    let previous = sketch.region_cache.borrow();
    if let Some(cached) = previous.as_ref().filter(|c| c.key == key) {
        return Ok(cached.regions.clone());
    }
    let mut groups = BTreeMap::new();
    let mut profiles = vec![];
    let mut reused = 0;
    for ids in crate::kernel::sketch::region_groups(sketch)? {
        let key = crate::kernel::sketch::geometry_key(sketch, Some(&ids))?;
        let cached = previous.as_ref().and_then(|p| p.groups.get(&key));
        let group = if let Some(cached) = cached {
            reused += 1;
            Rc::clone(cached)
        } else {
            Rc::new(crate::kernel::sketch::regions(sketch, &ids)?)
        };
        profiles.extend(group.iter().cloned());
        groups.insert(key, group);
    }
    crate::kernel::sketch::sort_profiles(&mut profiles);
    if std::env::var_os("PAMATCAD_GEOMETRY_PROFILE").is_some() {
        eprintln!(
            "{}",
            serde_json::json!({"event":"sketch.regions","groups":groups.len(),"reused":reused,"rebuilt":groups.len()-reused})
        );
    }
    drop(previous);
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
        groups,
    }));
    Ok(regions)
}
