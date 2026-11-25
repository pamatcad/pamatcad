use super::*;
use crate::formula::{self, Expression as E, Instruction, Quantity};
use std::{ffi::c_char, ops::Range};
mod components;
pub(super) use components::Cache;

#[repr(C)]
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SolveProfile {
    prepare_ms: f64,
    diagnose_ms: f64,
    solve_ms: f64,
    jacobian_ms: f64,
    freedom_ms: f64,
    attempts: usize,
}

#[repr(C)]
#[derive(Clone, PartialEq)]
struct Equation {
    start: usize,
    count: usize,
    tag: i32,
}
#[repr(C)]
#[derive(Clone, PartialEq)]
struct VariableGroup {
    start: usize,
    count: usize,
}
#[repr(C)]
struct DragTarget {
    x: usize,
    y: usize,
    position: [f64; 2],
}
extern "C" {
    fn pamat_sketch_solve(
        values: *mut f64,
        count: usize,
        geometry_count: usize,
        fixed: *const u8,
        preferred: *const u8,
        code: *const Instruction,
        equations: *const Equation,
        equation_count: usize,
        permanent_count: usize,
        drag: *const DragTarget,
        drag_count: usize,
        dragging: bool,
        dof: *mut i32,
        movable: *mut u8,
        group_indices: *const usize,
        groups: *const VariableGroup,
        group_count: usize,
        group_dof: *mut i32,
        diagnostics: *mut i32,
        diagnostic_count: *mut usize,
        error: *mut c_char,
        error_size: usize,
        profile: *mut SolveProfile,
    ) -> i32;
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}
fn constant(value: f64) -> E {
    E::number(value)
}
fn sub(a: [E; 2], b: [E; 2]) -> [E; 2] {
    [
        a[0].clone().sub(b[0].clone()),
        a[1].clone().sub(b[1].clone()),
    ]
}
fn dot(a: [E; 2], b: [E; 2]) -> E {
    a[0].clone()
        .mul(b[0].clone())
        .add(a[1].clone().mul(b[1].clone()))
}
fn cross(a: [E; 2], b: [E; 2]) -> E {
    a[0].clone()
        .mul(b[1].clone())
        .sub(a[1].clone().mul(b[0].clone()))
}
fn length(v: [E; 2]) -> E {
    dot(v.clone(), v).sqrt()
}

struct System<'a> {
    sketch: &'a Sketch,
    ranges: BTreeMap<String, Range<usize>>,
    values: Vec<f64>,
}
impl<'a> System<'a> {
    fn new(sketch: &'a Sketch) -> Self {
        let mut system = Self {
            sketch,
            ranges: BTreeMap::new(),
            values: vec![],
        };
        for (id, entity) in &sketch.entities {
            let start = system.values.len();
            match &entity.geometry {
                SketchGeometry::Point { position } => system.values.extend(position),
                SketchGeometry::Circle { radius, .. } => system.values.push(*radius),
                SketchGeometry::Arc {
                    radius, start, end, ..
                } => system.values.extend([*radius, *start, *end]),
                SketchGeometry::Ellipse {
                    major,
                    minor,
                    angle,
                    ..
                } => system.values.extend([*major, *minor, *angle]),
                _ => (),
            }
            system.ranges.insert(id.clone(), start..system.values.len());
        }
        system
    }
    fn variables(&self, id: &str) -> Result<Vec<E>> {
        Ok(self
            .ranges
            .get(id)
            .ok_or_else(|| invalid("Sketch entity does not exist"))?
            .clone()
            .map(E::variable)
            .collect())
    }
    fn geometry(&self, id: &str) -> Result<&SketchGeometry> {
        self.sketch
            .entities
            .get(id)
            .map(|e| &e.geometry)
            .ok_or_else(|| invalid("Sketch entity does not exist"))
    }
    fn point(&self, id: &str) -> Result<[E; 2]> {
        if !matches!(self.geometry(id)?, SketchGeometry::Point { .. }) {
            return Err(invalid("Select a sketch point"));
        }
        let p = self.variables(id)?;
        Ok([p[0].clone(), p[1].clone()])
    }
    fn line(&self, id: &str) -> Result<([E; 2], [E; 2])> {
        if let SketchGeometry::Line { from, to } = self.geometry(id)? {
            Ok((self.point(from)?, self.point(to)?))
        } else {
            Err(invalid("Select a sketch line"))
        }
    }
    fn center(&self, id: &str) -> Result<[E; 2]> {
        match self.geometry(id)? {
            SketchGeometry::Circle { center, .. }
            | SketchGeometry::Arc { center, .. }
            | SketchGeometry::Ellipse { center, .. } => self.point(center),
            _ => Err(invalid("Select a curve with a center")),
        }
    }
    fn radius(&self, id: &str) -> Result<E> {
        if !matches!(
            self.geometry(id)?,
            SketchGeometry::Circle { .. } | SketchGeometry::Arc { .. }
        ) {
            return Err(invalid("Select a circle or arc"));
        }
        Ok(self.variables(id)?[0].clone())
    }
    fn distance(&self, a: &str, b: &str) -> Result<E> {
        Ok(length(sub(self.point(a)?, self.point(b)?)))
    }
    fn line_length(&self, id: &str) -> Result<E> {
        let (a, b) = self.line(id)?;
        Ok(length(sub(b, a)))
    }
    fn point_on_curve(&self, point: &str, curve: &str) -> Result<E> {
        let p = self.point(point)?;
        match self.geometry(curve)? {
            SketchGeometry::Line { .. } => {
                let (a, b) = self.line(curve)?;
                let direction = sub(b, a.clone());
                Ok(cross(sub(p, a), direction.clone()).div(length(direction)))
            }
            SketchGeometry::Circle { .. } | SketchGeometry::Arc { .. } => {
                Ok(length(sub(p, self.center(curve)?)).sub(self.radius(curve)?))
            }
            SketchGeometry::Ellipse { .. } => {
                let delta = sub(p, self.center(curve)?);
                let vars = self.variables(curve)?;
                let c = vars[2].clone().cos();
                let s = vars[2].clone().sin();
                let x = delta[0]
                    .clone()
                    .mul(c.clone())
                    .add(delta[1].clone().mul(s.clone()));
                let y = delta[1].clone().mul(c).sub(delta[0].clone().mul(s));
                Ok(x.div(vars[0].clone())
                    .square()
                    .add(y.div(vars[1].clone()).square())
                    .sub(constant(1.)))
            }
            _ => Err(invalid("Point-on-curve requires a line or conic")),
        }
    }
    fn measurement(&self, dim: &SketchDimension) -> Result<E> {
        let p = &dim.parameters;
        let curve = p
            .line
            .as_ref()
            .or(p.curve.as_ref())
            .or(p.curves.first())
            .map(|r| r.id.as_str());
        let points = || -> Result<(&str, &str)> {
            if p.points.len() != 2 {
                Err(invalid("Dimension requires two points"))
            } else {
                Ok((&p.points[0].id, &p.points[1].id))
            }
        };
        match dim.kind {
            DimensionKind::Length => {
                self.line_length(curve.ok_or_else(|| invalid("Length requires a line"))?)
            }
            DimensionKind::Distance => {
                if p.points.len() == 1 && p.line.is_some() {
                    self.line(&p.line.as_ref().unwrap().id)?;
                    return Ok(self
                        .point_on_curve(&p.points[0].id, &p.line.as_ref().unwrap().id)?
                        .abs());
                }
                if p.curves.len() == 2 && p.points.is_empty() {
                    let (a, _) = self.line(&p.curves[1].id)?;
                    let (b, c) = self.line(&p.curves[0].id)?;
                    let v = sub(c, b.clone());
                    return Ok(cross(sub(a, b), v.clone()).div(length(v)).abs());
                }
                let (a, b) = points()?;
                self.distance(a, b)
            }
            DimensionKind::HorizontalDistance | DimensionKind::VerticalDistance => {
                let (a, b) = points()?;
                let index = usize::from(dim.kind == DimensionKind::VerticalDistance);
                Ok(self.point(b)?[index]
                    .clone()
                    .sub(self.point(a)?[index].clone()))
            }
            DimensionKind::Radius | DimensionKind::Diameter => Ok(self
                .radius(curve.ok_or_else(|| invalid("Radius requires a curve"))?)?
                .scale(if dim.kind == DimensionKind::Diameter {
                    2.
                } else {
                    1.
                })),
            DimensionKind::MajorRadius | DimensionKind::MinorRadius => {
                let id = curve.ok_or_else(|| invalid("Ellipse dimension requires a curve"))?;
                if !matches!(self.geometry(id)?, SketchGeometry::Ellipse { .. }) {
                    return Err(invalid("Select an ellipse"));
                }
                Ok(
                    self.variables(id)?[usize::from(dim.kind == DimensionKind::MinorRadius)]
                        .clone(),
                )
            }
            DimensionKind::Angle => {
                if let Some(id) = curve.filter(|_| p.curves.len() < 2) {
                    let radians = match self.geometry(id)? {
                        SketchGeometry::Arc { .. } => {
                            let v = self.variables(id)?;
                            v[2].clone().sub(v[1].clone())
                        }
                        SketchGeometry::Ellipse { .. } => self.variables(id)?[2].clone(),
                        SketchGeometry::Line { .. } => {
                            let (a, b) = self.line(id)?;
                            let v = sub(b, a);
                            v[1].clone().atan2(v[0].clone())
                        }
                        _ => {
                            return Err(invalid("Angle requires a line, arc, ellipse or two lines"))
                        }
                    };
                    return Ok(radians.scale(180. / std::f64::consts::PI));
                }
                if p.curves.len() != 2 {
                    return Err(invalid("Angle requires two lines"));
                }
                let (a, b) = self.line(&p.curves[0].id)?;
                let (c, d) = self.line(&p.curves[1].id)?;
                let u = sub(b, a);
                let v = sub(d, c);
                let angle = cross(u.clone(), v.clone())
                    .atan2(dot(u, v))
                    .scale(180. / std::f64::consts::PI);
                Ok(match p.angle_branch {
                    Some(AngleBranch::Reversed) => angle.scale(-1.),
                    Some(AngleBranch::Supplementary) => constant(180.).sub(angle),
                    Some(AngleBranch::ReversedSupplementary) => constant(180.).add(angle),
                    _ => angle,
                })
            }
        }
    }
    fn constraint(&self, c: &SketchConstraint) -> Result<Vec<E>> {
        let p = &c.parameters;
        let points = |n| {
            if p.points.len() == n {
                Ok(())
            } else {
                Err(invalid(format!("Constraint requires {n} points")))
            }
        };
        let curves = |n| {
            if p.curves.len() == n {
                Ok(())
            } else {
                Err(invalid(format!("Constraint requires {n} curves")))
            }
        };
        use ConstraintKind::*;
        Ok(match c.kind {
            Coincident => {
                points(2)?;
                sub(self.point(&p.points[0].id)?, self.point(&p.points[1].id)?).to_vec()
            }
            PointOnCurve => {
                points(1)?;
                curves(1)?;
                vec![self.point_on_curve(&p.points[0].id, &p.curves[0].id)?]
            }
            Fix => {
                let fixed = self
                    .sketch
                    .fixed
                    .get(&c.id)
                    .ok_or_else(|| invalid("Missing fixed geometry"))?;
                let mut equations = vec![];
                for (id, values) in fixed {
                    for (e, v) in self.variables(id)?.into_iter().zip(values) {
                        equations.push(e.sub(constant(*v)));
                    }
                }
                equations
            }
            Horizontal | Vertical => {
                let (a, b) = if p.curves.len() == 1 {
                    self.line(&p.curves[0].id)?
                } else {
                    points(2)?;
                    (self.point(&p.points[0].id)?, self.point(&p.points[1].id)?)
                };
                vec![sub(b, a)[usize::from(c.kind == Horizontal)].clone()]
            }
            Parallel | Perpendicular | Collinear => {
                curves(2)?;
                let (a, b) = self.line(&p.curves[0].id)?;
                let (c0, d) = self.line(&p.curves[1].id)?;
                let u = sub(b, a.clone());
                let v = sub(d, c0.clone());
                let normalizer = length(u.clone()).mul(length(v.clone()));
                let mut equations = vec![if c.kind == Perpendicular {
                    dot(u.clone(), v).div(normalizer)
                } else {
                    cross(u.clone(), v).div(normalizer)
                }];
                if c.kind == Collinear {
                    equations.push(cross(sub(c0, a), u.clone()).div(length(u)));
                }
                equations
            }
            Concentric => {
                curves(2)?;
                sub(self.center(&p.curves[0].id)?, self.center(&p.curves[1].id)?).to_vec()
            }
            Equal => {
                curves(2)?;
                let a = &p.curves[0].id;
                let b = &p.curves[1].id;
                if matches!(self.geometry(a)?, SketchGeometry::Line { .. }) {
                    vec![self.line_length(a)?.sub(self.line_length(b)?)]
                } else {
                    vec![self.radius(a)?.sub(self.radius(b)?)]
                }
            }
            Midpoint => {
                points(1)?;
                curves(1)?;
                let (a, b) = self.line(&p.curves[0].id)?;
                let p = self.point(&p.points[0].id)?;
                (0..2)
                    .map(|i| p[i].clone().sub(a[i].clone().add(b[i].clone()).scale(0.5)))
                    .collect()
            }
            Symmetric => {
                points(2)?;
                curves(1)?;
                let a = self.point(&p.points[0].id)?;
                let b = self.point(&p.points[1].id)?;
                let (c, d) = self.line(&p.curves[0].id)?;
                let u = sub(d, c.clone());
                let middle = [
                    a[0].clone().add(b[0].clone()).scale(0.5),
                    a[1].clone().add(b[1].clone()).scale(0.5),
                ];
                vec![
                    cross(sub(middle, c), u.clone()).div(length(u.clone())),
                    dot(sub(b, a), u.clone()).div(length(u)),
                ]
            }
            Tangent => {
                curves(2)?;
                let mut a = &p.curves[0].id;
                let mut b = &p.curves[1].id;
                if matches!(self.geometry(b)?, SketchGeometry::Line { .. }) {
                    std::mem::swap(&mut a, &mut b);
                }
                if let SketchGeometry::Line { .. } = self.geometry(a)? {
                    // At a shared arc endpoint, distance-to-circle tangency is
                    // singular: coincidence already supplies its first derivative.
                    // The radius/line perpendicular equation retains the tangent DOF.
                    if let (
                        SketchGeometry::Line { from: lf, to: lt },
                        SketchGeometry::Arc {
                            center,
                            from: af,
                            to: at,
                            ..
                        },
                    ) = (self.geometry(a)?, self.geometry(b)?)
                    {
                        let shared = [af, at].into_iter().find(|point| {
                            [lf, lt].into_iter().any(|end| {
                                *point == end
                                    || self.sketch.constraints.values().any(|relation| {
                                        relation.kind == ConstraintKind::Coincident
                                            && relation
                                                .parameters
                                                .points
                                                .iter()
                                                .any(|r| &r.id == *point)
                                            && relation
                                                .parameters
                                                .points
                                                .iter()
                                                .any(|r| &r.id == end)
                                    })
                            })
                        });
                        if let Some(point) = shared {
                            let direction = sub(self.point(lt)?, self.point(lf)?);
                            let radius = sub(self.point(point)?, self.point(center)?);
                            return Ok(vec![dot(direction.clone(), radius.clone())
                                .div(length(direction).mul(length(radius)))]);
                        }
                    }
                    let (from, to) = self.line(a)?;
                    let direction = sub(to, from.clone());
                    let offset =
                        cross(sub(self.center(b)?, from), direction.clone()).div(length(direction));
                    let sign = if offset.evaluate(&self.values)? < 0. {
                        -1.
                    } else {
                        1.
                    };
                    vec![offset.sub(self.radius(b)?.scale(sign))]
                } else {
                    let distance = length(sub(self.center(a)?, self.center(b)?));
                    let r1 = self.radius(a)?;
                    let r2 = self.radius(b)?;
                    let d = distance.evaluate(&self.values)?;
                    let ra = r1.evaluate(&self.values)?;
                    let rb = r2.evaluate(&self.values)?;
                    let radius = if (d - (ra - rb).abs()).abs() < (d - ra - rb).abs() {
                        r1.sub(r2).scale(if ra >= rb { 1. } else { -1. })
                    } else {
                        r1.add(r2)
                    };
                    vec![distance.sub(radius)]
                }
            }
        })
    }
}

pub(super) fn solve(
    sketch: &mut Sketch,
    units: SceneUnits,
    external: &BTreeMap<String, (SketchEntityRef, FormulaQuantity<FormulaUnit>)>,
    drag: &[DragGoal],
) -> Result<()> {
    let started = std::env::var_os("PAMATCAD_SKETCH_PROFILE").map(|_| std::time::Instant::now());
    let mut system = System::new(sketch);
    let mut targets = BTreeMap::new();
    let geometry_count = system.values.len();
    let mut preferred = vec![0u8; geometry_count];
    let mut temporary = vec![];
    for goal in drag {
        let (id, position) = match goal {
            DragGoal::Point(id, p) | DragGoal::CircularEdge(id, p) => (id, p),
        };
        if let DragGoal::CircularEdge(_, _) = goal {
            let (center, radius) = match system.geometry(id)? {
                SketchGeometry::Circle { center, radius } => (center, radius),
                SketchGeometry::Arc { center, radius, .. } => {
                    let range = &system.ranges[id];
                    preferred[range.start + 1] = 1;
                    preferred[range.start + 2] = 1;
                    (center, radius)
                }
                _ => return Err(invalid("Select a circle or arc to drag")),
            };
            let center_index = system.ranges[center].start;
            let c = sketch.point_position(center)?;
            let d = [position[0] - c[0], position[1] - c[1]];
            let norm = d[0].hypot(d[1]);
            let direction = if norm > LINEAR_TOLERANCE {
                [d[0] / norm, d[1] / norm]
            } else {
                [1., 0.]
            };
            let x = system.values.len();
            system
                .values
                .extend([c[0] + radius * direction[0], c[1] + radius * direction[1]]);
            preferred.extend([0, 0]);
            preferred[center_index] = 1;
            preferred[center_index + 1] = 1;
            let cursor = [E::variable(x), E::variable(x + 1)];
            temporary.push(length(sub(cursor, system.center(id)?)).sub(system.radius(id)?));
            targets.insert(x, *position);
            continue;
        }
        // A corner may have multiple coincident endpoints. Use the same target variables
        // regardless of which endpoint the picker or API caller supplies.
        let mut coincident = std::collections::BTreeSet::from([id.to_owned()]);
        loop {
            let before = coincident.len();
            for constraint in sketch
                .constraints
                .values()
                .filter(|c| c.kind == ConstraintKind::Coincident)
            {
                if constraint
                    .parameters
                    .points
                    .iter()
                    .any(|p| coincident.contains(&p.id))
                {
                    coincident.extend(constraint.parameters.points.iter().map(|p| p.id.clone()));
                }
            }
            if before == coincident.len() {
                break;
            }
        }
        let x = system.ranges[coincident.first().unwrap()].start;
        // Center dragging prefers a rigid arc translation; these are temporary
        // preferences, so connected or dimensioned geometry can still limit it.
        for (arc_id, entity) in &sketch.entities {
            if let SketchGeometry::Arc { center, .. } = &entity.geometry {
                if coincident.contains(center) {
                    for index in system.ranges[arc_id].clone() {
                        preferred[index] = 1;
                    }
                }
            }
        }
        if let Some(previous) = targets.insert(x, *position) {
            if previous != *position {
                return Err(invalid("Coincident drag targets must agree"));
            }
        }
    }
    let drag: Vec<_> = targets
        .into_iter()
        .map(|(x, position)| DragTarget {
            x,
            y: x + 1,
            position,
        })
        .collect();
    let mut fixed = vec![0u8; system.values.len()];
    for values in sketch
        .fixed
        .iter()
        .filter(|(id, _)| sketch.constraints.contains_key(*id))
        .map(|(_, v)| v)
    {
        for (id, values) in values {
            if let Some(range) = system.ranges.get(id) {
                for (index, value) in range.clone().zip(values) {
                    system.values[index] = *value;
                    fixed[index] = 1;
                }
            }
        }
    }
    let mut residuals: Vec<(i32, E)> = vec![];
    for text in sketch.texts.values() {
        let Some(frame) = &text.frame else { continue };
        let [[x0, y0], [x1, y1]] = text.layout;
        let height = y1 - y0;
        let b = system.point(&frame.bottom_left.id)?;
        let t = system.point(&frame.top_left.id)?;
        let v = sub(t, b.clone());
        let u = [
            v[1].clone().scale((x1 - x0) / height),
            v[0].clone().scale(-(x1 - x0) / height),
        ];
        residuals.push((1, length(v.clone()).sub(constant(height))));
        for (point, vertical, horizontal) in [
            (&frame.bottom_right, 0., 1.),
            (&frame.top_right, 1., 1.),
            (&frame.center, 0.5, 0.5),
        ] {
            let p = system.point(&point.id)?;
            for axis in 0..2 {
                residuals.push((
                    1,
                    p[axis].clone().sub(
                        b[axis]
                            .clone()
                            .add(v[axis].clone().scale(vertical))
                            .add(u[axis].clone().scale(horizontal)),
                    ),
                ));
            }
        }
    }
    for (point, (mode, handles)) in sketch.spline_handles() {
        if mode == SplineHandleMode::Aligned && handles.len() == 2 {
            let center = system.point(&point)?;
            let a = sub(system.point(&handles[0].id)?, center.clone());
            let b = sub(system.point(&handles[1].id)?, center);
            residuals.push((1, cross(a, b)));
        }
    }
    for (id, entity) in &sketch.entities {
        if let Some(axes) = sketch.ellipse_axes.get(id) {
            let center = system.center(id)?;
            let vars = system.variables(id)?;
            let c = vars[2].clone().cos();
            let s = vars[2].clone().sin();
            for (index, axis) in axes.iter().enumerate() {
                let Some(axis) = axis else { continue };
                let (from, to) = system.line(axis)?;
                let direction = if index == 0 {
                    [c.clone(), s.clone()]
                } else {
                    [s.clone().scale(-1.), c.clone()]
                };
                for (point, sign) in [(from, -1.), (to, 1.)] {
                    for i in 0..2 {
                        residuals.push((
                            1,
                            point[i].clone().sub(
                                center[i]
                                    .clone()
                                    .add(direction[i].clone().mul(vars[index].clone()).scale(sign)),
                            ),
                        ));
                    }
                }
            }
        }
        if let SketchGeometry::Arc {
            center, from, to, ..
        } = &entity.geometry
        {
            let c = system.point(center)?;
            let vars = system.variables(id)?;
            for (point, angle) in [(from, vars[1].clone()), (to, vars[2].clone())] {
                let p = system.point(point)?;
                residuals.push((
                    1,
                    p[0].clone()
                        .sub(c[0].clone().add(vars[0].clone().mul(angle.clone().cos()))),
                ));
                residuals.push((
                    1,
                    p[1].clone()
                        .sub(c[1].clone().add(vars[0].clone().mul(angle.sin()))),
                ));
            }
        }
    }
    for (index, constraint) in sketch.constraints.values().enumerate() {
        if constraint.kind == ConstraintKind::Fix {
            continue;
        }
        residuals.extend(
            system
                .constraint(constraint)?
                .into_iter()
                .map(|e| (index as i32 + 1, e)),
        );
    }
    let mut bound = sketch.bindings.clone();
    let mut dependencies = BTreeMap::new();
    for (index, dim) in sketch.dimensions.values().enumerate() {
        let dimension = if dim.kind == DimensionKind::Angle {
            FormulaDimension::Angle
        } else {
            FormulaDimension::Length
        };
        let mut refs = vec![];
        if dim.parameters.mode == DimensionMode::Driving {
            let value = dim
                .parameters
                .value
                .as_ref()
                .ok_or_else(|| invalid("Driving dimension requires a formula"))?;
            let expression = match value {
                Formula::Number(n) => constant(*n),
                Formula::Expression(source)
                | Formula::Evaluated(EvaluatedFormula {
                    expression: source, ..
                }) => {
                    let bindings = bound.entry(dim.id.clone()).or_default();
                    let quantity = formula::parse(source, &mut |token| {
                        let reference = bindings
                            .get(token)
                            .cloned()
                            .or_else(|| {
                                sketch
                                    .dimensions
                                    .values()
                                    .find(|d| {
                                        d.id == token
                                            || format!(
                                                "dimension[{}]",
                                                d.parameters.name.as_deref().unwrap_or("")
                                            ) == token
                                            || d.parameters.name.as_deref() == Some(token)
                                    })
                                    .map(|d| sketch.entity_ref(&d.id))
                            })
                            .or_else(|| external.get(token).map(|v| v.0.clone()))
                            .ok_or_else(|| invalid(format!("Unknown dimension {token}")))?;
                        bindings.insert(token.to_owned(), reference.clone());
                        refs.push(reference.clone());
                        if reference.sketch_id == sketch.data.id {
                            let referenced = sketch
                                .dimensions
                                .get(&reference.id)
                                .ok_or_else(|| invalid("Referenced dimension was removed"))?;
                            Ok(Quantity {
                                expression: system.measurement(referenced)?,
                                powers: if referenced.kind == DimensionKind::Angle {
                                    [0, 1]
                                } else {
                                    [1, 0]
                                },
                            })
                        } else {
                            let (_, quantity) = external
                                .values()
                                .find(|(r, _)| r == &reference)
                                .ok_or_else(|| {
                                    invalid("Referenced sketch dimension is unavailable")
                                })?;
                            Ok(Quantity {
                                expression: constant(quantity.value * quantity.unit.scale()),
                                powers: quantity.unit.dimension().powers(),
                            })
                        }
                    })?;
                    if quantity.powers == [0, 0] {
                        quantity.expression.scale(units.unit(dimension).scale())
                    } else if quantity.powers == dimension.powers() {
                        quantity.expression
                    } else {
                        return Err(invalid("Dimension formula has incompatible units"));
                    }
                }
            };
            residuals.push((
                (sketch.constraints.len() + index + 1) as i32,
                system.measurement(dim)?.sub(expression),
            ));
            if dim.kind == DimensionKind::Distance && dim.parameters.curves.len() == 2 {
                let (a, b) = system.line(&dim.parameters.curves[0].id)?;
                let (c, d) = system.line(&dim.parameters.curves[1].id)?;
                let (u, v) = (sub(b, a), sub(d, c));
                residuals.push((
                    (sketch.constraints.len() + index + 1) as i32,
                    cross(u.clone(), v.clone()).div(length(u).mul(length(v))),
                ));
            }
        }
        dependencies.insert(dim.id.clone(), refs);
    }
    let permanent_count = residuals.len();
    for (index, equation) in temporary.into_iter().enumerate() {
        residuals.push((
            (sketch.constraints.len() + sketch.dimensions.len() + index + 1) as i32,
            equation,
        ));
    }
    let mut instructions = vec![];
    let mut equations = vec![];
    for (tag, e) in &residuals {
        let start = instructions.len();
        e.instructions(&mut instructions);
        equations.push(Equation {
            start,
            count: instructions.len() - start,
            tag: *tag,
        });
    }
    let mut values = system.values.clone();
    let mut group_indices = vec![];
    let mut groups = vec![];
    let mut freedom = vec![];
    for entity in sketch.entities.values() {
        let ids = sketch.selected_entities(std::slice::from_ref(&entity.reference))?;
        let start = group_indices.len();
        for id in ids {
            group_indices.extend(system.ranges[&id].clone());
        }
        groups.push(VariableGroup {
            start,
            count: group_indices.len() - start,
        });
        let maximum = match &entity.geometry {
            SketchGeometry::Point { .. } => 2,
            SketchGeometry::Line { .. } => 4,
            SketchGeometry::Circle { .. } => 3,
            SketchGeometry::Arc { .. } | SketchGeometry::Ellipse { .. } => 5,
            SketchGeometry::Spline { points, .. } => {
                let mut variables = points
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>();
                if let Some(spline) = sketch.splines.get(&entity.reference.id) {
                    variables.extend(
                        spline
                            .fit_points
                            .iter()
                            .flat_map(|p| p.incoming.iter().chain(&p.outgoing))
                            .map(|r| r.id.clone()),
                    );
                }
                let aligned = sketch
                    .spline_handles()
                    .values()
                    .filter(|(mode, handles)| {
                        *mode == SplineHandleMode::Aligned
                            && handles.len() == 2
                            && handles.iter().all(|r| variables.contains(&r.id))
                    })
                    .count();
                variables.len() * 2 - aligned
            }
        };
        freedom.push(SketchEntityFreedom {
            entity: entity.reference.clone(),
            degrees_of_freedom: 0,
            unconstrained_degrees_of_freedom: maximum,
        });
    }
    let mut group_dof = vec![0i32; groups.len()];
    let mut profile = SolveProfile::default();
    let variable_ids: Vec<_> = system
        .ranges
        .iter()
        .flat_map(|(id, range)| (0..range.len()).map(move |axis| (id.clone(), axis)))
        .collect();
    let build_ms = started.map(|s| s.elapsed().as_secs_f64() * 1000.);
    let (dof, solver_cache, statistics) = components::solve(
        &mut values,
        geometry_count,
        &fixed,
        &preferred,
        &instructions,
        &equations,
        permanent_count,
        &drag,
        &group_indices,
        &groups,
        &mut group_dof,
        &variable_ids,
        &sketch.solver_cache,
        started.map(|_| &mut profile),
    )?;
    if let Some(started) = started {
        eprintln!(
            "{}",
            serde_json::json!({
                "event": "sketch.solve", "drag": !drag.is_empty(), "components": statistics.count,
                "largestComponent": statistics.largest, "partitionMs": statistics.partition_ms,
                "reusedComponents": statistics.reused,
                "variables": values.len(), "equations": equations.len(),
                "buildMs": build_ms, "native": profile, "totalMs": started.elapsed().as_secs_f64() * 1000.,
            })
        );
    }
    let computed = sketch
        .dimensions
        .values()
        .map(|d| Ok((d.id.clone(), system.measurement(d)?.evaluate(&values)?)))
        .collect::<Result<Vec<_>>>()?;
    let ranges = system.ranges;
    let mut movable_entities = vec![];
    for (item, dof) in freedom.iter_mut().zip(group_dof) {
        item.degrees_of_freedom = dof.max(0) as usize;
        if dof > 0 {
            movable_entities.push(item.entity.clone());
        }
    }
    for (id, entity) in &mut sketch.entities {
        let range = ranges[id].clone();
        let v = &values[range.clone()];
        match &mut entity.geometry {
            SketchGeometry::Point { position } => *position = [v[0], v[1]],
            SketchGeometry::Circle { radius, .. } => *radius = v[0],
            SketchGeometry::Arc {
                radius, start, end, ..
            } => {
                *radius = v[0];
                *start = v[1];
                *end = v[2];
            }
            SketchGeometry::Ellipse {
                major,
                minor,
                angle,
                ..
            } => {
                *major = v[0];
                *minor = v[1];
                *angle = v[2];
            }
            _ => (),
        }
    }
    for (id, value) in computed {
        let dim = sketch.dimensions.get_mut(&id).unwrap();
        let unit = units.unit(if dim.kind == DimensionKind::Angle {
            FormulaDimension::Angle
        } else {
            FormulaDimension::Length
        });
        dim.computed = FormulaQuantity {
            value: value / unit.scale(),
            unit,
        };
        dim.dependencies = dependencies.remove(&id).unwrap_or_default();
    }
    sketch.bindings = bound;
    sketch.status = SketchSolveStatus {
        state: if dof == 0 {
            SketchSolveState::Constrained
        } else {
            SketchSolveState::Underconstrained
        },
        degrees_of_freedom: dof.max(0) as usize,
        movable_entities,
        entities: freedom,
        warnings: sketch.status.warnings.clone(),
    };
    sketch.sync_text_frames()?;
    sketch.validate_geometry()?;
    sketch.solver_cache = solver_cache;
    Ok(())
}

pub(super) fn fixed_values(
    sketch: &Sketch,
    refs: &[SketchEntityRef],
) -> Result<BTreeMap<String, Vec<f64>>> {
    let system = System::new(sketch);
    let mut ids = std::collections::BTreeSet::new();
    for r in refs {
        sketch.check_reference(r)?;
        ids.insert(r.id.clone());
        match system.geometry(&r.id)? {
            SketchGeometry::Line { from, to } => {
                ids.insert(from.clone());
                ids.insert(to.clone());
            }
            SketchGeometry::Circle { center, .. }
            | SketchGeometry::Arc { center, .. }
            | SketchGeometry::Ellipse { center, .. } => {
                ids.insert(center.clone());
            }
            SketchGeometry::Spline { points, .. } => {
                ids.extend(points.iter().cloned());
                if let Some(spline) = sketch.splines.get(&r.id) {
                    ids.extend(
                        spline
                            .fit_points
                            .iter()
                            .flat_map(|p| p.incoming.iter().chain(&p.outgoing))
                            .map(|r| r.id.clone()),
                    );
                }
            }
            _ => (),
        }
    }
    Ok(ids
        .into_iter()
        .map(|id| {
            let values = system.values[system.ranges[&id].clone()].to_vec();
            (id, values)
        })
        .collect())
}
