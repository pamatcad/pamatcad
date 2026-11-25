use super::*;
use std::collections::BTreeSet;
fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}
impl Sketch {
    pub fn validate_transform(&self, requested: &Self, refs: &[SketchEntityRef]) -> Result<()> {
        if !self.auto_recompute {
            return Ok(());
        }
        let refs = requested
            .selected_entities(refs)?
            .iter()
            .map(|id| requested.entity_ref(id))
            .collect::<Vec<_>>();
        let expected = solver::fixed_values(requested, &refs)?;
        let solved = solver::fixed_values(self, &refs)?;
        if expected.iter().any(|(id, values)| {
            values
                .iter()
                .zip(&solved[id])
                .any(|(a, b)| (a - b).abs() > LINEAR_TOLERANCE)
        }) {
            return Err(invalid("Constraints prevent the requested transform"));
        }
        Ok(())
    }
    pub fn selected_entities(&self, references: &[SketchEntityRef]) -> Result<BTreeSet<String>> {
        let mut ids = BTreeSet::new();
        for r in references {
            self.check_reference(r)?;
            ids.insert(r.id.clone());
            match &self.entities[&r.id].geometry {
                SketchGeometry::Line { from, to } => {
                    ids.insert(from.clone());
                    ids.insert(to.clone());
                }
                SketchGeometry::Arc {
                    center, from, to, ..
                } => {
                    ids.insert(center.clone());
                    ids.insert(from.clone());
                    ids.insert(to.clone());
                }
                SketchGeometry::Circle { center, .. } | SketchGeometry::Ellipse { center, .. } => {
                    ids.insert(center.clone());
                }
                SketchGeometry::Spline { points, .. } => {
                    ids.extend(points.iter().cloned());
                    if let Some(spline) = self.splines.get(&r.id) {
                        ids.extend(spline.envelope.iter().map(|r| r.id.clone()));
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
        Ok(ids)
    }
    pub fn transform(
        &mut self,
        input: TransformSketchGeometry,
        angle: f64,
        scale: f64,
    ) -> Result<Vec<SketchEntityRef>> {
        if !input
            .pivot
            .iter()
            .chain(&input.translation)
            .all(|v| v.is_finite())
            || !scale.is_finite()
            || scale <= 0.
            || !angle.is_finite()
        {
            return Err(invalid(
                "Transform requires finite values and a positive scale",
            ));
        }
        for reference in &input.entities {
            self.ensure_text_outline_editable(&reference.id)?;
            self.ensure_text_frame_editable(&reference.id)?;
        }
        let mut references = input.entities.clone();
        for reference in &input.entities {
            if let Some(axes) = self.ellipse_axes.get(&reference.id) {
                references.extend(axes.iter().flatten().map(|id| self.entity_ref(id)));
            }
        }
        let ids = self.selected_entities(&references)?;
        if !input.copy
            && ids
                .iter()
                .any(|id| id == "origin" || self.entities[id].projected)
        {
            return Err(invalid("Origin and projected geometry are read-only"));
        }
        let mut remap = BTreeMap::new();
        for id in &ids {
            remap.insert(
                id.clone(),
                if input.copy {
                    self.id("geometry")
                } else {
                    id.clone()
                },
            );
        }
        let (c, s) = (angle.cos(), angle.sin());
        let mut entities = vec![];
        for id in &ids {
            let mut entity = self.entities[id].clone();
            entity.reference = self.entity_ref(&remap[id]);
            if input.copy {
                entity.projected = false;
            }
            match &mut entity.geometry {
                SketchGeometry::Point { position } => {
                    let [x, y] = [
                        (position[0] - input.pivot[0]) * scale,
                        (position[1] - input.pivot[1]) * scale,
                    ];
                    *position = [
                        input.pivot[0] + x * c - y * s + input.translation[0],
                        input.pivot[1] + x * s + y * c + input.translation[1],
                    ];
                }
                SketchGeometry::Line { from, to } => {
                    *from = remap[from].clone();
                    *to = remap[to].clone();
                }
                SketchGeometry::Circle { center, radius } => {
                    *center = remap[center].clone();
                    *radius *= scale;
                }
                SketchGeometry::Arc {
                    center,
                    from,
                    to,
                    radius,
                    start,
                    end,
                } => {
                    *center = remap[center].clone();
                    *from = remap[from].clone();
                    *to = remap[to].clone();
                    *radius *= scale;
                    *start += angle;
                    *end += angle;
                }
                SketchGeometry::Ellipse {
                    center,
                    major,
                    minor,
                    angle: a,
                } => {
                    *center = remap[center].clone();
                    *major *= scale;
                    *minor *= scale;
                    *a += angle;
                }
                SketchGeometry::Spline { points, .. } => {
                    for p in points {
                        *p = remap[p].clone();
                    }
                }
            }
            entities.push(entity);
        }
        let constraints = self
            .constraints
            .values()
            .filter(|c| {
                c.parameters
                    .points
                    .iter()
                    .chain(&c.parameters.curves)
                    .all(|r| ids.contains(&r.id))
            })
            .cloned()
            .collect::<Vec<_>>();
        for entity in entities {
            self.entities.insert(entity.reference.id.clone(), entity);
        }
        if input.copy {
            let copies = self
                .splines
                .values()
                .filter(|s| remap.contains_key(&s.curve.id))
                .cloned()
                .map(|mut s| {
                    s.curve.id = remap[&s.curve.id].clone();
                    for r in &mut s.envelope {
                        r.id = remap[&r.id].clone();
                    }
                    for node in &mut s.fit_points {
                        for r in std::iter::once(&mut node.point)
                            .chain(&mut node.incoming)
                            .chain(&mut node.outgoing)
                        {
                            r.id = remap[&r.id].clone();
                        }
                    }
                    (s.curve.id.clone(), s)
                })
                .collect::<Vec<_>>();
            self.splines.extend(copies);
            let axes = self
                .ellipse_axes
                .iter()
                .filter(|(id, _)| remap.contains_key(*id))
                .map(|(id, axes)| {
                    (
                        remap[id].clone(),
                        axes.each_ref()
                            .map(|axis| axis.as_ref().and_then(|id| remap.get(id)).cloned()),
                    )
                })
                .collect::<Vec<_>>();
            self.ellipse_axes.extend(axes);
        }
        if !input.copy {
            for c in &constraints {
                if c.kind == ConstraintKind::Fix {
                    let references = c
                        .parameters
                        .points
                        .iter()
                        .chain(&c.parameters.curves)
                        .cloned()
                        .collect::<Vec<_>>();
                    self.fixed
                        .insert(c.id.clone(), solver::fixed_values(self, &references)?);
                }
            }
        }
        if input.copy {
            for mut c in constraints {
                for r in c
                    .parameters
                    .points
                    .iter_mut()
                    .chain(&mut c.parameters.curves)
                {
                    r.id = remap[&r.id].clone();
                }
                self.add_constraint(c.kind, c.parameters)?;
            }
        }
        let dimensions = self
            .dimensions
            .values()
            .filter(|d| {
                d.parameters
                    .points
                    .iter()
                    .chain(&d.parameters.curves)
                    .chain(d.parameters.line.iter())
                    .chain(d.parameters.curve.iter())
                    .all(|r| ids.contains(&r.id))
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut dimension_ids = BTreeMap::new();
        if input.copy {
            for d in &dimensions {
                dimension_ids.insert(d.id.clone(), self.id("dimension"));
            }
        }
        for mut d in dimensions {
            let source_id = d.id.clone();
            if let Some(annotation) = &mut d.parameters.annotation {
                let [x, y] = [
                    (annotation.position[0] - input.pivot[0]) * scale,
                    (annotation.position[1] - input.pivot[1]) * scale,
                ];
                annotation.position = [
                    input.pivot[0] + x * c - y * s + input.translation[0],
                    input.pivot[1] + x * s + y * c + input.translation[1],
                ];
            }
            if input.copy {
                d.id = dimension_ids[&source_id].clone();
                d.parameters.name = None;
                for r in d
                    .parameters
                    .points
                    .iter_mut()
                    .chain(&mut d.parameters.curves)
                    .chain(d.parameters.line.iter_mut())
                    .chain(d.parameters.curve.iter_mut())
                {
                    r.id = remap[&r.id].clone();
                }
            }
            if scale != 1.
                && d.kind != DimensionKind::Angle
                && d.parameters.mode == DimensionMode::Driving
            {
                d.parameters.value = Some(match d.parameters.value.unwrap() {
                    Formula::Number(n) => Formula::Number(n * scale),
                    Formula::Expression(s) => Formula::Expression(format!("({s}) * {scale}")),
                    Formula::Evaluated(mut e) => {
                        e.expression = format!("({}) * {scale}", e.expression);
                        Formula::Evaluated(e)
                    }
                });
            }
            if input.copy {
                if let Some(bindings) = self.bindings.get(&source_id).cloned() {
                    let mapped = bindings
                        .into_iter()
                        .map(|(symbol, mut reference)| {
                            if reference.sketch_id == self.data.id {
                                if let Some(id) = dimension_ids.get(&reference.id) {
                                    reference.id = id.clone();
                                }
                            }
                            (symbol, reference)
                        })
                        .collect();
                    self.bindings.insert(d.id.clone(), mapped);
                }
            }
            self.dimensions.insert(d.id.clone(), d);
        }
        Ok(input
            .entities
            .iter()
            .map(|r| self.entity_ref(&remap[&r.id]))
            .collect())
    }
}
impl Sketch {
    pub fn import_curve(&mut self, kind: i32, data: &[f64]) -> Result<GeometryData> {
        let primitive = match kind {
            0 => Primitive::Point(PointParameters {
                position: [data[0], data[1]],
                construction: false,
            }),
            1 => Primitive::Line(LineParameters {
                from: [data[0], data[1]],
                to: [data[2], data[3]],
                construction: false,
            }),
            2 => Primitive::Circle(CircleParameters {
                center: [data[0], data[1]],
                diameter: 2. * data[2],
                construction: false,
            }),
            3 => Primitive::Arc(ArcParameters {
                center: [data[0], data[1]],
                radius: data[2],
                start: data[3].to_degrees(),
                end: data[4].to_degrees(),
                construction: false,
            }),
            4 => {
                let degree = data[0] as usize;
                let n = data[1] as usize;
                let mut points = vec![];
                for p in data[4..4 + 2 * n].chunks_exact(2) {
                    points.push(self.add_point([p[0], p[1]], false)?);
                }
                let start = 4 + 2 * n;
                let id = self.id("spline");
                let curve = self.insert_geometry(
                    id.clone(),
                    SketchGeometry::Spline {
                        points: points.iter().map(|r| r.id.clone()).collect(),
                        degree,
                        knots: data[start..start + n + degree + 1].to_vec(),
                        weights: data[start + n + degree + 1..].to_vec(),
                        closed: data[2] != 0.,
                        fit: false,
                    },
                    false,
                );
                return Ok(GeometryData {
                    id,
                    points,
                    curves: vec![curve],
                    constraints: vec![],
                });
            }
            _ => return Err(invalid("Unknown imported curve type")),
        };
        match self.add_primitive(primitive)? {
            PrimitiveData::Geometry(d) => Ok(d),
            PrimitiveData::Circle(d) => Ok(GeometryData {
                id: d.id,
                points: d.points,
                curves: d.curves,
                constraints: d.constraints,
            }),
            _ => unreachable!(),
        }
    }
}
impl Sketch {
    pub fn modify_curves(
        &mut self,
        references: &[SketchEntityRef],
        operation: i32,
        values: &[f64],
    ) -> Result<SketchEditResult> {
        for r in references {
            self.check_reference(r)?;
            self.ensure_spline_helper_editable(&r.id)?;
            self.ensure_text_outline_editable(&r.id)?;
            self.ensure_text_frame_editable(&r.id)?;
            if self.entities[&r.id].projected && operation != 1 {
                return Err(invalid("Projected curves are read-only"));
            }
        }
        if operation == 4
            && (references.len() != 1 || values.len() != 2 || values.iter().any(|v| !v.is_finite()))
        {
            return Err(invalid(
                "Remove requires one curve and a finite sketch position",
            ));
        }
        let mut ids = references.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        let construction = operation == 4 && self.entities[&ids[0]].construction;
        if operation == 4 {
            if matches!(self.entities[&ids[0]].geometry, SketchGeometry::Point { .. }) {
                return Err(invalid("Select a curve to remove"));
            }
            let target = ids[0].clone();
            let axes = self.ellipse_axes.get(&target);
            ids.extend(
                self.entities
                    .values()
                    .filter(|e| {
                        e.reference.id != target
                            && !axes.is_some_and(|axes| {
                                axes.iter().flatten().any(|id| id == &e.reference.id)
                            })
                            && !matches!(e.geometry, SketchGeometry::Point { .. })
                            && self.ensure_spline_helper_editable(&e.reference.id).is_ok()
                            && self.ensure_text_frame_editable(&e.reference.id).is_ok()
                    })
                    .map(|e| e.reference.id.clone()),
            );
        }
        let mut modified = vec![];
        if operation == 4 {
            modified.extend(crate::kernel::sketch::modify(
                self,
                &ids,
                operation,
                0.,
                Some([values[0], values[1]]),
            )?);
        } else {
            for value in values {
                modified.extend(crate::kernel::sketch::modify(
                    self, &ids, operation, *value, None,
                )?);
            }
        }
        let mut removed = if operation == 1 {
            BTreeSet::new()
        } else {
            modified
                .iter()
                .filter_map(|(id, _, _)| id.clone())
                .collect::<BTreeSet<_>>()
        };
        let mut removed_ids = removed.iter().cloned().collect();
        if operation == 4 {
            if let Some(axes) = self.ellipse_axes.get(&ids[0]) {
                removed.extend(axes.iter().flatten().cloned());
            }
        }
        self.spline_removal(&mut removed_ids)?;
        removed.extend(removed_ids);
        let original_points = self
            .selected_entities(
                &removed
                    .iter()
                    .map(|id| self.entity_ref(id))
                    .collect::<Vec<_>>(),
            )?
            .into_iter()
            .filter(|id| {
                !removed.contains(id)
                    && matches!(self.entities[id].geometry, SketchGeometry::Point { .. })
            })
            .map(|id| Ok((id.clone(), self.point_position(&id)?)))
            .collect::<Result<BTreeMap<_, _>>>()?;
        for id in &removed {
            self.entities.remove(id);
        }
        self.ellipse_axes.retain(|id, axes| {
            for axis in axes {
                if axis.as_ref().is_some_and(|id| removed.contains(id)) {
                    *axis = None;
                }
            }
            !removed.contains(id)
        });
        let mut created = vec![];
        let mut new_points = vec![];
        for (_, kind, data) in modified {
            // Remove emits the source even when no surviving interval remains.
            if kind == 0 {
                continue;
            }
            let mut geometry = self.import_curve(kind, &data)?;
            if construction {
                for reference in geometry.points.iter().chain(&geometry.curves) {
                    self.entities.get_mut(&reference.id).unwrap().construction = true;
                }
            }
            let mut remap = BTreeMap::new();
            for point in &mut geometry.points {
                let position = self.point_position(&point.id)?;
                if let Some((id, _)) = original_points.iter().find(|(_, p)| {
                    (p[0] - position[0]).hypot(p[1] - position[1]) < LINEAR_TOLERANCE
                }) {
                    remap.insert(point.id.clone(), id.clone());
                    self.entities.remove(&point.id);
                    *point = self.entity_ref(id);
                }
            }
            let replace = |id: &mut String| {
                if let Some(next) = remap.get(id) {
                    *id = next.clone();
                }
            };
            for curve in &geometry.curves {
                match &mut self.entities.get_mut(&curve.id).unwrap().geometry {
                    SketchGeometry::Line { from, to } => {
                        replace(from);
                        replace(to);
                    }
                    SketchGeometry::Circle { center, .. }
                    | SketchGeometry::Ellipse { center, .. } => replace(center),
                    SketchGeometry::Arc {
                        center, from, to, ..
                    } => {
                        replace(center);
                        replace(from);
                        replace(to);
                    }
                    SketchGeometry::Spline { points, .. } => {
                        for p in points {
                            replace(p);
                        }
                    }
                    _ => (),
                }
            }
            for curve in &geometry.curves {
                if let SketchGeometry::Spline { points, .. } = &self.entities[&curve.id].geometry {
                    let points = points
                        .iter()
                        .map(|id| self.entity_ref(id))
                        .collect::<Vec<_>>();
                    let envelope = points
                        .windows(2)
                        .map(|p| self.spline_line(&p[0], &p[1]))
                        .collect();
                    self.splines.insert(
                        curve.id.clone(),
                        SketchSpline {
                            curve: curve.clone(),
                            fit_points: vec![],
                            envelope,
                        },
                    );
                }
            }
            created.extend(geometry.curves);
            new_points.extend(geometry.points);
        }
        let curves = self
            .entities
            .values()
            .filter(|e| !matches!(e.geometry, SketchGeometry::Point { .. }))
            .map(|e| e.reference.clone())
            .collect::<Vec<_>>();
        let used = self.selected_entities(&curves)?;
        for id in original_points.keys() {
            if id != "origin" && !used.contains(id) {
                self.entities.remove(id);
                removed.insert(id.clone());
            }
        }
        let removed_constraints = self
            .constraints
            .values()
            .filter(|c| {
                c.parameters
                    .points
                    .iter()
                    .chain(&c.parameters.curves)
                    .any(|r| removed.contains(&r.id))
            })
            .map(|c| c.id.clone())
            .collect::<Vec<_>>();
        let removed_dimensions = self
            .dimensions
            .values()
            .filter(|d| {
                d.parameters
                    .points
                    .iter()
                    .chain(&d.parameters.curves)
                    .chain(d.parameters.line.iter())
                    .chain(d.parameters.curve.iter())
                    .any(|r| removed.contains(&r.id))
            })
            .map(|d| d.id.clone())
            .collect::<Vec<_>>();
        if self.dimensions.values().any(|d| {
            !removed_dimensions.contains(&d.id)
                && d.dependencies
                    .iter()
                    .any(|r| removed_dimensions.contains(&r.id))
        }) {
            return Err(invalid("The edit would remove a referenced dimension"));
        }
        for id in &removed_constraints {
            self.constraints.remove(id);
            self.fixed.remove(id);
        }
        for id in &removed_dimensions {
            self.dimensions.remove(id);
            self.bindings.remove(id);
        }
        // Result endpoints at the same location remain joined while sketching.
        let mut representative: Vec<SketchEntityRef> = vec![];
        for point in new_points {
            let p = self.point_position(&point.id)?;
            if let Some(other) = representative.iter().find(|r| {
                let q = self.point_position(&r.id).unwrap();
                (q[0] - p[0]).hypot(q[1] - p[1]) < LINEAR_TOLERANCE
            }) {
                if point.id == other.id {
                    continue;
                }
                self.add_constraint(
                    ConstraintKind::Coincident,
                    ConstraintParameters {
                        points: vec![point.clone(), other.clone()],
                        curves: vec![],
                    },
                )?;
            } else {
                representative.push(point);
            }
        }
        Ok(SketchEditResult {
            created,
            removed: removed.into_iter().map(|id| self.entity_ref(&id)).collect(),
            removed_constraints,
            removed_dimensions,
        })
    }
}
