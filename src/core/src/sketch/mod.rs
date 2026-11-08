pub mod primitives;
mod regions;
pub use regions::Boundary;

use crate::{
    error::{CoreError, ErrorCode, Result},
    protocol::*,
};
use primitives::{Line, Rectangle};
use regions::Region;
use std::collections::BTreeMap;

pub const LINEAR_TOLERANCE: f64 = 1e-7;

#[derive(Clone, Copy)]
pub struct Frame {
    pub origin: [f64; 3],
    pub u: [f64; 3],
    pub v: [f64; 3],
    pub normal: [f64; 3],
}

impl Frame {
    pub fn builtin(plane: Plane) -> Self {
        let x = [1., 0., 0.];
        let y = [0., 1., 0.];
        let z = [0., 0., 1.];
        let (u, v, normal) = match plane {
            Plane::Xy => (x, y, z),
            Plane::Xz => (x, z, [0., -1., 0.]),
            Plane::Yz => (y, z, x),
        };
        Self {
            origin: [0.; 3],
            u,
            v,
            normal,
        }
    }

    pub fn point(self, [u, v]: [f64; 2]) -> [f64; 3] {
        std::array::from_fn(|i| self.origin[i] + u * self.u[i] + v * self.v[i])
    }
}

pub struct Sketch {
    pub data: SketchData,
    pub frame: Frame,
    pub circles: BTreeMap<String, CircleParameters>,
    pub lines: BTreeMap<String, Line>,
    pub rectangles: Vec<Rectangle>,
    pub regions: Vec<Region>,
}

impl Sketch {
    pub fn new(id: String, plane: SketchSupport, frame: Frame) -> Self {
        Self {
            data: SketchData {
                id,
                scene_id: plane.scene_id().to_owned(),
                plane,
                completed: false,
            },
            frame,
            circles: BTreeMap::new(),
            lines: BTreeMap::new(),
            rectangles: Vec::new(),
            regions: Vec::new(),
        }
    }

    pub fn ensure_editable(&self) -> Result<()> {
        if self.data.completed {
            return Err(CoreError::new(
                ErrorCode::InvalidState,
                "Sketch is already complete",
            ));
        }
        Ok(())
    }

    pub fn complete(&mut self) -> Result<SketchData> {
        self.ensure_editable()?;
        let regions = regions::evaluate(self)?;
        self.regions = regions;
        self.data.completed = true;
        Ok(self.data.clone())
    }

    pub fn only_region(&self) -> Result<RegionRef> {
        if !self.data.completed {
            return Err(CoreError::new(
                ErrorCode::InvalidState,
                "Complete the sketch before selecting a region",
            ));
        }
        match self.regions.as_slice() {
            [region] => Ok(region.reference.clone()),
            [] => Err(CoreError::new(
                ErrorCode::NotFound,
                "Sketch has no bounded regions",
            )),
            _ => Err(CoreError::new(
                ErrorCode::AmbiguousRegion,
                "Sketch has more than one region",
            )),
        }
    }

    pub fn profile(&self, reference: &RegionRef) -> Result<&Boundary> {
        if !self.data.completed {
            return Err(CoreError::new(
                ErrorCode::InvalidState,
                "Sketch is not complete",
            ));
        }
        let region = self
            .regions
            .iter()
            .find(|r| r.reference == *reference)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "Sketch region does not exist"))?;
        Ok(&region.boundary)
    }
}
