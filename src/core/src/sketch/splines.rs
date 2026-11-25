use super::*;
use std::collections::{BTreeMap, BTreeSet};

fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}

impl Sketch {
    pub(super) fn spline_line(
        &mut self,
        from: &SketchEntityRef,
        to: &SketchEntityRef,
    ) -> SketchEntityRef {
        let id = self.id("line");
        let line = self.insert_geometry(
            id,
            SketchGeometry::Line {
                from: from.id.clone(),
                to: to.id.clone(),
            },
            true,
        );
        self.entities.get_mut(&line.id).unwrap().allow_collapse = true;
        line
    }

    pub(super) fn add_spline(&mut self, mut p: SplineParameters) -> Result<GeometryData> {
        if p.degree.is_some_and(|degree| !(1..=5).contains(&degree)) {
            return Err(invalid("Spline degree must be 1 through 5"));
        }
        let repeated = p.points.len() > 2 && p.points.first() == p.points.last();
        p.closed |= repeated;
        if repeated {
            p.points.pop();
        }
        let degree = if p.fit {
            3
        } else {
            p.degree.unwrap_or(3).min(p.points.len().saturating_sub(1))
        };
        if p.points.len() < 2 || p.closed && p.points.len() < 3 || degree == 0 || degree > 5 {
            return Err(invalid(
                "Spline requires at least two points (three when closed) and degree 1 through 5",
            ));
        }
        if p.points
            .windows(2)
            .any(|p| (p[1][0] - p[0][0]).hypot(p[1][1] - p[0][1]) <= LINEAR_TOLERANCE)
        {
            return Err(invalid("Consecutive spline points must differ"));
        }
        let mut points = p
            .points
            .iter()
            .map(|&position| self.add_point(position, p.construction))
            .collect::<Result<Vec<_>>>()?;
        if p.closed && !p.fit {
            points.push(points[0].clone());
        }
        let n = points.len();
        let knots = (0..n + degree + 1)
            .map(|i| {
                if i <= degree {
                    0.
                } else if i >= n {
                    1.
                } else {
                    (i - degree) as f64 / (n - degree) as f64
                }
            })
            .collect();
        let id = self.id("spline");
        let curve = self.insert_geometry(
            id.clone(),
            SketchGeometry::Spline {
                points: points.iter().map(|p| p.id.clone()).collect(),
                degree,
                knots,
                weights: vec![1.; n],
                closed: p.closed,
                fit: p.fit,
            },
            p.construction,
        );
        let mut spline = SketchSpline {
            curve: curve.clone(),
            fit_points: vec![],
            envelope: vec![],
        };
        if p.fit {
            for (i, point) in points.iter().enumerate() {
                let center = p.points[i];
                let previous = (i > 0 || p.closed).then(|| p.points[(i + n - 1) % n]);
                let next = (i + 1 < n || p.closed).then(|| p.points[(i + 1) % n]);
                let a = previous.unwrap_or(center);
                let b = next.unwrap_or(center);
                let mut direction = [b[0] - a[0], b[1] - a[1]];
                let mut length = direction[0].hypot(direction[1]);
                if length <= LINEAR_TOLERANCE {
                    direction = [b[0] - center[0], b[1] - center[1]];
                    length = direction[0].hypot(direction[1]);
                }
                if length <= LINEAR_TOLERANCE {
                    return Err(invalid("Spline tangent cannot be determined"));
                }
                let mut handles = [None, None];
                for (index, neighbor) in [previous, next].into_iter().enumerate() {
                    if let Some(neighbor) = neighbor {
                        let size = (neighbor[0] - center[0]).hypot(neighbor[1] - center[1]) / 3.;
                        let sign = if index == 0 { -1. } else { 1. };
                        let tip = self.add_point(
                            std::array::from_fn(|j| {
                                center[j] + sign * size * direction[j] / length
                            }),
                            true,
                        )?;
                        spline.envelope.push(self.spline_line(point, &tip));
                        handles[index] = Some(tip);
                    }
                }
                spline.fit_points.push(SplineFitPoint {
                    point: point.clone(),
                    incoming: handles[0].clone(),
                    outgoing: handles[1].clone(),
                    mode: SplineHandleMode::Aligned,
                });
            }
        } else {
            for pair in points.windows(2) {
                spline.envelope.push(self.spline_line(&pair[0], &pair[1]));
            }
        }
        let mut curves = vec![curve];
        curves.extend(spline.envelope.iter().cloned());
        self.splines.insert(id.clone(), spline);
        Ok(GeometryData {
            id,
            points,
            curves,
            constraints: vec![],
        })
    }

    pub(crate) fn spline_helper(&self, id: &str) -> bool {
        self.splines.values().any(|s| {
            s.envelope.iter().any(|r| r.id == id)
                || s.fit_points
                    .iter()
                    .any(|p| p.incoming.iter().chain(&p.outgoing).any(|r| r.id == id))
        })
    }

    pub(crate) fn ensure_spline_helper_editable(&self, id: &str) -> Result<()> {
        if self.spline_helper(id) {
            Err(invalid("Spline handles and control polygons belong to their curve and remain construction geometry"))
        } else {
            Ok(())
        }
    }

    pub(crate) fn spline_handles(
        &self,
    ) -> BTreeMap<String, (SplineHandleMode, Vec<SketchEntityRef>)> {
        let mut nodes = BTreeMap::<String, (SplineHandleMode, Vec<SketchEntityRef>)>::new();
        for node in self.splines.values().flat_map(|s| &s.fit_points) {
            let entry = nodes
                .entry(node.point.id.clone())
                .or_insert((node.mode, vec![]));
            for tip in node.incoming.iter().chain(&node.outgoing) {
                if !entry.1.contains(tip) {
                    entry.1.push(tip.clone());
                }
            }
        }
        nodes
    }

    pub(crate) fn spline_endpoint(&self, id: &str) -> bool {
        self.splines
            .keys()
            .filter(|curve| match &self.entities[*curve].geometry {
                SketchGeometry::Spline {
                    points,
                    closed: false,
                    ..
                } => {
                    points.first().is_some_and(|p| p == id)
                        || points.last().is_some_and(|p| p == id)
                }
                _ => false,
            })
            .count()
            == 1
            && self
                .splines
                .keys()
                .filter(|curve| match &self.entities[*curve].geometry {
                    SketchGeometry::Spline { points, .. } => points.contains(&id.to_owned()),
                    _ => false,
                })
                .count()
                == 1
    }

    pub(crate) fn set_spline_handle_mode(
        &mut self,
        point: &SketchEntityRef,
        mode: SplineHandleMode,
    ) -> Result<()> {
        self.check_reference(point)?;
        if !self.spline_handles().contains_key(&point.id) {
            return Err(invalid("Select a fit point"));
        }
        for node in self
            .splines
            .values_mut()
            .flat_map(|s| &mut s.fit_points)
            .filter(|p| p.point == *point)
        {
            node.mode = mode;
        }
        Ok(())
    }

    pub(crate) fn join_splines(
        &mut self,
        from: &SketchEntityRef,
        to: &SketchEntityRef,
    ) -> Result<()> {
        self.check_reference(from)?;
        self.check_reference(to)?;
        if from == to {
            return Ok(());
        }
        if !self.spline_endpoint(&from.id) || !self.spline_endpoint(&to.id) {
            return Err(invalid("Select two unjoined spline endpoints"));
        }
        let a = self.point_position(&from.id)?;
        let b = self.point_position(&to.id)?;
        let handles = self.spline_handles();
        let mode = if [from, to].iter().any(|p| {
            handles
                .get(&p.id)
                .is_some_and(|h| h.0 == SplineHandleMode::Independent)
        }) {
            SplineHandleMode::Independent
        } else {
            SplineHandleMode::Aligned
        };
        if let Some((_, tips)) = handles.get(&from.id) {
            for tip in tips {
                let old = self.point_position(&tip.id)?;
                let mut position = std::array::from_fn(|i| old[i] + b[i] - a[i]);
                if mode == SplineHandleMode::Aligned {
                    if let Some(other) = handles.get(&to.id).and_then(|h| h.1.first()) {
                        let q = self.point_position(&other.id)?;
                        let length = (q[0] - b[0]).hypot(q[1] - b[1]);
                        let size = (old[0] - a[0]).hypot(old[1] - a[1]);
                        if length > LINEAR_TOLERANCE {
                            position =
                                std::array::from_fn(|i| b[i] - (q[i] - b[i]) * size / length);
                        }
                    }
                }
                self.entities.get_mut(&tip.id).unwrap().geometry =
                    SketchGeometry::Point { position };
            }
        }
        let replace = |id: &mut String| {
            if *id == from.id {
                *id = to.id.clone();
            }
        };
        for entity in self.entities.values_mut() {
            match &mut entity.geometry {
                SketchGeometry::Line { from, to } => {
                    replace(from);
                    replace(to);
                }
                SketchGeometry::Arc {
                    center, from, to, ..
                } => {
                    replace(center);
                    replace(from);
                    replace(to);
                }
                SketchGeometry::Circle { center, .. } | SketchGeometry::Ellipse { center, .. } => {
                    replace(center)
                }
                SketchGeometry::Spline { points, closed, .. } => {
                    for p in points.iter_mut() {
                        replace(p);
                    }
                    *closed |= points.first() == points.last();
                }
                _ => (),
            }
        }
        for spline in self.splines.values_mut() {
            for node in &mut spline.fit_points {
                if node.point == *from {
                    node.point = to.clone();
                }
                if node.point == *to {
                    node.mode = mode;
                }
            }
        }
        for c in self.constraints.values_mut() {
            for r in c
                .parameters
                .points
                .iter_mut()
                .chain(&mut c.parameters.curves)
            {
                replace(&mut r.id);
            }
        }
        for d in self.dimensions.values_mut() {
            for r in d
                .parameters
                .points
                .iter_mut()
                .chain(&mut d.parameters.curves)
                .chain(&mut d.parameters.line)
                .chain(&mut d.parameters.curve)
                .chain(&mut d.dependencies)
            {
                replace(&mut r.id);
            }
        }
        for values in self.fixed.values_mut() {
            if let Some(value) = values.remove(&from.id) {
                if values.get(&to.id).is_some_and(|other| other != &value) {
                    return Err(invalid(
                        "Fixed endpoints cannot be joined at different positions",
                    ));
                }
                values.insert(to.id.clone(), value);
            }
        }
        for values in self.bindings.values_mut() {
            for r in values.values_mut() {
                replace(&mut r.id);
            }
        }
        self.entities.remove(&from.id);
        self.constraints.retain(|_, c| {
            c.kind != ConstraintKind::Coincident
                || c.parameters.points.windows(2).any(|p| p[0] != p[1])
        });
        Ok(())
    }

    pub(crate) fn spline_removal(&mut self, ids: &mut Vec<String>) -> Result<()> {
        let removed: BTreeSet<_> = ids
            .iter()
            .filter(|id| self.splines.contains_key(*id))
            .cloned()
            .collect();
        for id in ids.iter() {
            if self.spline_helper(id)
                && !removed.iter().any(|curve| {
                    let s = &self.splines[curve];
                    s.envelope.iter().any(|r| &r.id == id)
                        || s.fit_points
                            .iter()
                            .any(|p| p.incoming.iter().chain(&p.outgoing).any(|r| &r.id == id))
                })
            {
                return self.ensure_spline_helper_editable(id);
            }
        }
        for id in removed {
            let spline = self.splines.remove(&id).unwrap();
            for r in spline.envelope.iter().chain(
                spline
                    .fit_points
                    .iter()
                    .flat_map(|p| p.incoming.iter().chain(&p.outgoing)),
            ) {
                if !ids.contains(&r.id) {
                    ids.push(r.id.clone());
                }
            }
        }
        Ok(())
    }
}
