mod display;
mod edit;
pub mod primitives;
mod projections;
mod regions;
mod solver;
mod text;
pub mod types;
pub use regions::Boundary;

use crate::{
    error::{CoreError, ErrorCode, Result},
    protocol::*,
};
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

#[derive(Clone)]
pub struct Sketch {
    pub data: SketchData,
    pub frame: Frame,
    pub regions: Vec<Region>,
    pub entities: BTreeMap<String, SketchEntity>,
    pub constraints: BTreeMap<String, SketchConstraint>,
    pub dimensions: BTreeMap<String, SketchDimension>,
    pub fixed: BTreeMap<String, BTreeMap<String, Vec<f64>>>,
    pub bindings: BTreeMap<String, BTreeMap<String, SketchEntityRef>>,
    pub status: SketchSolveStatus,
    pub revision: u64,
    pub auto_recompute: bool,
    pub next_id: u64,
    pub saved: Option<Box<Sketch>>,
    pub projections: BTreeMap<String, SketchProjection>,
}

impl Sketch {
    pub fn new(id: String, plane: SketchSupport, frame: Frame) -> Self {
        let mut sketch = Self {
            data: SketchData {
                id,
                scene_id: plane.scene_id().to_owned(),
                plane,
                completed: false,
                name: None,
            },
            frame,
            regions: Vec::new(),
            entities: BTreeMap::new(),
            constraints: BTreeMap::new(),
            dimensions: BTreeMap::new(),
            fixed: BTreeMap::new(),
            bindings: BTreeMap::new(),
            status: SketchSolveStatus {
                state: SketchSolveState::Underconstrained,
                degrees_of_freedom: 0,
                movable_entities: vec![],
                entities: vec![],
                warnings: vec![],
            },
            revision: 0,
            auto_recompute: true,
            next_id: 0,
            saved: None,
            projections: BTreeMap::new(),
        };
        let origin = sketch.entity_ref("origin");
        sketch.entities.insert(
            "origin".into(),
            SketchEntity {
                reference: origin.clone(),
                geometry: SketchGeometry::Point { position: [0., 0.] },
                construction: true,
                projected: false,
            },
        );
        sketch.constraints.insert(
            "origin-fixed".into(),
            SketchConstraint {
                id: "origin-fixed".into(),
                kind: ConstraintKind::Fix,
                parameters: ConstraintParameters {
                    points: vec![origin],
                    curves: vec![],
                },
            },
        );
        sketch.fixed.insert(
            "origin-fixed".into(),
            BTreeMap::from([("origin".into(), vec![0., 0.])]),
        );
        sketch
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

    pub fn entity_ref(&self, id: &str) -> SketchEntityRef {
        SketchEntityRef {
            scene_id: self.data.scene_id.clone(),
            sketch_id: self.data.id.clone(),
            id: id.to_owned(),
        }
    }
    pub fn id(&mut self, kind: &str) -> String {
        self.next_id += 1;
        format!("{kind}{}", self.next_id)
    }
    pub fn check_reference(&self, r: &SketchEntityRef) -> Result<()> {
        if r.scene_id != self.data.scene_id
            || r.sketch_id != self.data.id
            || !self.entities.contains_key(&r.id)
        {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Sketch entity reference does not belong to this sketch",
            ));
        }
        Ok(())
    }
    pub fn state(&self) -> SketchState {
        SketchState {
            sketch: self.data.clone(),
            frame: self.frame,
            entities: self.entities.values().cloned().collect(),
            constraints: self
                .constraints
                .values()
                .filter(|c| c.id != "origin-fixed")
                .cloned()
                .collect(),
            dimensions: self.dimensions.values().cloned().collect(),
            status: self.status.clone(),
            revision: self.revision,
            auto_recompute: self.auto_recompute,
            projections: self.projections.values().cloned().collect(),
        }
    }
    pub fn solve(
        &mut self,
        units: SceneUnits,
        external: &BTreeMap<String, (SketchEntityRef, FormulaQuantity<FormulaUnit>)>,
    ) -> Result<()> {
        solver::solve(self, units, external, &[])
    }
    pub fn solve_drag(
        &mut self,
        units: SceneUnits,
        external: &BTreeMap<String, (SketchEntityRef, FormulaQuantity<FormulaUnit>)>,
        targets: &[(String, [f64; 2])],
    ) -> Result<()> {
        solver::solve(self, units, external, targets)
    }
    pub fn add_constraint(
        &mut self,
        kind: ConstraintKind,
        parameters: ConstraintParameters,
    ) -> Result<SketchConstraint> {
        for r in parameters.points.iter().chain(&parameters.curves) {
            self.check_reference(r)?;
        }
        let id = self.id("constraint");
        if kind == ConstraintKind::Fix {
            self.fixed.insert(
                id.clone(),
                solver::fixed_values(
                    self,
                    &parameters
                        .points
                        .iter()
                        .chain(&parameters.curves)
                        .cloned()
                        .collect::<Vec<_>>(),
                )?,
            );
        }
        let constraint = SketchConstraint {
            id: id.clone(),
            kind,
            parameters,
        };
        self.constraints.insert(id, constraint.clone());
        Ok(constraint)
    }
    pub fn point_position(&self, id: &str) -> Result<[f64; 2]> {
        match self.entities.get(id).map(|e| &e.geometry) {
            Some(SketchGeometry::Point { position }) => Ok(*position),
            _ => Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "Point does not exist",
            )),
        }
    }
    pub fn validate_geometry(&self) -> Result<()> {
        for e in self.entities.values() {
            match &e.geometry {
                SketchGeometry::Line { from, to } => {
                    let a = self.point_position(from)?;
                    let b = self.point_position(to)?;
                    if (a[0] - b[0]).hypot(a[1] - b[1]) <= LINEAR_TOLERANCE {
                        return Err(CoreError::new(
                            ErrorCode::InvalidParameter,
                            "Line endpoints must differ",
                        ));
                    }
                }
                SketchGeometry::Circle { radius, .. } | SketchGeometry::Arc { radius, .. }
                    if *radius <= LINEAR_TOLERANCE =>
                {
                    return Err(CoreError::new(
                        ErrorCode::InvalidParameter,
                        "Radius must be positive",
                    ))
                }
                SketchGeometry::Ellipse { major, minor, .. }
                    if major.min(*minor) <= LINEAR_TOLERANCE =>
                {
                    return Err(CoreError::new(
                        ErrorCode::InvalidParameter,
                        "Ellipse semiaxes must be positive",
                    ))
                }
                _ => (),
            }
        }
        Ok(())
    }

    pub fn proxy(&self) -> Result<SketchProxy> {
        let evaluated;
        let source = if self.data.completed {
            &self.regions
        } else {
            evaluated = regions::evaluate(self)?;
            &evaluated
        };
        let regions = source
            .iter()
            .map(|region| {
                let Boundary::Profile(profile) = &region.boundary;
                let loops = profile.loops()?;
                Ok(SketchRegionProxy {
                    region: region.reference.clone(),
                    boundary: loops.first().cloned().unwrap_or_default(),
                    holes: loops.into_iter().skip(1).collect(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(SketchProxy {
            sketch: SketchRef {
                scene_id: self.data.scene_id.clone(),
                id: self.data.id.clone(),
            },
            frame: self.frame,
            regions,
            curves: self.display_curves()?,
            points: self
                .entities
                .values()
                .filter_map(|e| {
                    if let SketchGeometry::Point { position } = &e.geometry {
                        Some(SketchPointProxy {
                            entity: e.reference.clone(),
                            position: self.frame.point(*position),
                            construction: e.construction,
                            projected: e.projected,
                        })
                    } else {
                        None
                    }
                })
                .collect(),
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
