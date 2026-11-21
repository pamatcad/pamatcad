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

pub use crate::protocol::PlaneFrame as Frame;

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

    pub(crate) fn coplanar_with(self, other: Self) -> bool {
        let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        let delta = std::array::from_fn(|i| other.origin[i] - self.origin[i]);
        dot(other.normal, self.u).hypot(dot(other.normal, self.v)) <= 1e-12
            && dot(delta, self.normal).abs() <= LINEAR_TOLERANCE
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

    pub fn all_regions(&self) -> Result<Vec<RegionRef>> {
        if !self.data.completed {
            return Err(CoreError::new(
                ErrorCode::InvalidState,
                "Complete the sketch before selecting regions",
            ));
        }
        Ok(self.regions.iter().map(|r| r.reference.clone()).collect())
    }

    pub fn proxy(&self) -> Result<SketchProxy> {
        self.all_regions()?;
        let regions = self
            .regions
            .iter()
            .map(|region| {
                let boundary = match &region.boundary {
                    Boundary::Lines(ids) => ids
                        .iter()
                        .map(|id| self.frame.point(self.lines[id].from))
                        .collect(),
                    Boundary::Circle(id) => {
                        let circle = &self.circles[id];
                        (0..128)
                            .map(|i| {
                                let angle = std::f64::consts::TAU * f64::from(i) / 128.;
                                self.frame.point([
                                    circle.center[0] + circle.diameter * angle.cos() / 2.,
                                    circle.center[1] + circle.diameter * angle.sin() / 2.,
                                ])
                            })
                            .collect()
                    }
                };
                SketchRegionProxy {
                    region: region.reference.clone(),
                    boundary,
                }
            })
            .collect();
        Ok(SketchProxy {
            sketch: SketchRef {
                scene_id: self.data.scene_id.clone(),
                id: self.data.id.clone(),
            },
            frame: self.frame,
            regions,
        })
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
