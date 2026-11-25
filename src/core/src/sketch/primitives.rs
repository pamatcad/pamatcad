use super::{Sketch, LINEAR_TOLERANCE};
use crate::{
    error::{CoreError, ErrorCode, Result},
    protocol::*,
};

fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}
fn finite(values: &[f64]) -> Result<()> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err(invalid("Sketch geometry requires finite coordinates"))
    }
}

impl Sketch {
    pub fn insert_geometry(
        &mut self,
        id: String,
        geometry: SketchGeometry,
        construction: bool,
    ) -> SketchEntityRef {
        let reference = self.entity_ref(&id);
        self.entities.insert(
            id,
            SketchEntity {
                reference: reference.clone(),
                geometry,
                construction,
                projected: false,
                allow_collapse: false,
            },
        );
        reference
    }
    pub fn add_point(&mut self, position: [f64; 2], construction: bool) -> Result<SketchEntityRef> {
        finite(&position)?;
        let id = self.id("point");
        Ok(self.insert_geometry(id, SketchGeometry::Point { position }, construction))
    }
    fn add_line(
        &mut self,
        from: [f64; 2],
        to: [f64; 2],
        construction: bool,
    ) -> Result<GeometryData> {
        if (to[0] - from[0]).hypot(to[1] - from[1]) <= LINEAR_TOLERANCE {
            return Err(invalid("Line endpoints must differ"));
        }
        let a = self.add_point(from, construction)?;
        let b = self.add_point(to, construction)?;
        let id = self.id("line");
        let line = self.insert_geometry(
            id.clone(),
            SketchGeometry::Line {
                from: a.id.clone(),
                to: b.id.clone(),
            },
            construction,
        );
        Ok(GeometryData {
            id,
            points: vec![a, b],
            curves: vec![line],
            constraints: vec![],
        })
    }
    fn add_arc(&mut self, p: ArcParameters) -> Result<GeometryData> {
        finite(&[p.radius, p.start, p.end])?;
        if p.radius <= LINEAR_TOLERANCE
            || (p.end - p.start).abs() < 1e-9
            || (p.end - p.start).abs() > 360. + 1e-9
        {
            return Err(invalid(
                "Arc requires a positive radius and a nonzero sweep up to 360 degrees",
            ));
        }
        let start = p.start.to_radians();
        let end = p.end.to_radians();
        let center = self.add_point(p.center, p.construction)?;
        let from = self.add_point(
            [
                p.center[0] + p.radius * start.cos(),
                p.center[1] + p.radius * start.sin(),
            ],
            p.construction,
        )?;
        let to = self.add_point(
            [
                p.center[0] + p.radius * end.cos(),
                p.center[1] + p.radius * end.sin(),
            ],
            p.construction,
        )?;
        let id = self.id("arc");
        let curve = self.insert_geometry(
            id.clone(),
            SketchGeometry::Arc {
                center: center.id.clone(),
                from: from.id.clone(),
                to: to.id.clone(),
                radius: p.radius,
                start,
                end,
            },
            p.construction,
        );
        Ok(GeometryData {
            id,
            points: vec![center, from, to],
            curves: vec![curve],
            constraints: vec![],
        })
    }
    pub fn add_primitive(&mut self, primitive: Primitive) -> Result<PrimitiveData> {
        self.ensure_editable()?;
        Ok(match primitive {
            Primitive::Text(p) => PrimitiveData::Geometry(self.add_text(p)?),
            Primitive::Point(p) => {
                let point = self.add_point(p.position, p.construction)?;
                PrimitiveData::Geometry(GeometryData {
                    id: point.id.clone(),
                    points: vec![point],
                    curves: vec![],
                    constraints: vec![],
                })
            }
            Primitive::Line(p) => {
                PrimitiveData::Geometry(self.add_line(p.from, p.to, p.construction)?)
            }
            Primitive::Rectangle(p) => {
                finite(&[p.from[0], p.from[1], p.to[0], p.to[1], p.angle])?;
                let min = std::array::from_fn(|i| p.from[i].min(p.to[i]));
                let max: [f64; 2] = std::array::from_fn(|i| p.from[i].max(p.to[i]));
                if (max[0] - min[0]).min(max[1] - min[1]) <= LINEAR_TOLERANCE {
                    return Err(invalid("Rectangle requires two nonzero dimensions"));
                }
                let angle = p.angle.to_radians();
                let (c, s) = (angle.cos(), angle.sin());
                let (anchor, origin, size) = if p.centered {
                    let dx = (p.to[0] - p.from[0]).abs();
                    let dy = (p.to[1] - p.from[1]).abs();
                    (p.from, [-dx, -dy], [2. * dx, 2. * dy])
                } else if p.angle != 0. {
                    (p.from, [0., 0.], [p.to[0] - p.from[0], p.to[1] - p.from[1]])
                } else {
                    (min, [0., 0.], [max[0] - min[0], max[1] - min[1]])
                };
                let positions = [[0., 0.], [size[0], 0.], size, [0., size[1]]].map(|q| {
                    let x = origin[0] + q[0];
                    let y = origin[1] + q[1];
                    [anchor[0] + x * c - y * s, anchor[1] + x * s + y * c]
                });
                let id = self.id("rectangle");
                let mut points = vec![];
                let mut curves = vec![];
                let mut constraints = vec![];
                for i in 0..4 {
                    let line =
                        self.add_line(positions[i], positions[(i + 1) % 4], p.construction)?;
                    points.extend(line.points);
                    curves.extend(line.curves);
                }
                for i in 0..4 {
                    constraints.push(
                        self.add_constraint(
                            ConstraintKind::Coincident,
                            ConstraintParameters {
                                points: vec![
                                    points[i * 2 + 1].clone(),
                                    points[((i + 1) % 4) * 2].clone(),
                                ],
                                curves: vec![],
                            },
                        )?
                        .id,
                    );
                }
                for i in 0..3 {
                    constraints.push(
                        self.add_constraint(
                            ConstraintKind::Perpendicular,
                            ConstraintParameters {
                                points: vec![],
                                curves: vec![curves[i].clone(), curves[i + 1].clone()],
                            },
                        )?
                        .id,
                    );
                }
                if p.angle == 0. {
                    constraints.push(
                        self.add_constraint(
                            ConstraintKind::Horizontal,
                            ConstraintParameters {
                                points: vec![],
                                curves: vec![curves[0].clone()],
                            },
                        )?
                        .id,
                    );
                }
                let lines = curves
                    .iter()
                    .map(|r| LineRef {
                        scene_id: r.scene_id.clone(),
                        sketch_id: r.sketch_id.clone(),
                        id: r.id.clone(),
                    })
                    .collect();
                if p.centered {
                    for [from, to] in [[0, 4], [2, 6]] {
                        let id = self.id("line");
                        curves.push(self.insert_geometry(
                            id,
                            SketchGeometry::Line {
                                from: points[from].id.clone(),
                                to: points[to].id.clone(),
                            },
                            true,
                        ));
                    }
                    let center = self.add_point(anchor, true)?;
                    constraints.push(
                        self.add_constraint(
                            ConstraintKind::Midpoint,
                            ConstraintParameters {
                                points: vec![center.clone()],
                                curves: vec![curves[4].clone()],
                            },
                        )?
                        .id,
                    );
                    points.push(center);
                }
                PrimitiveData::Rectangle(RectangleData {
                    id,
                    lines,
                    points,
                    curves,
                    constraints,
                })
            }
            Primitive::Circle(p) => {
                finite(&[p.diameter])?;
                if p.diameter <= LINEAR_TOLERANCE * 2. {
                    return Err(invalid("Circle requires a positive diameter"));
                }
                let center = self.add_point(p.center, p.construction)?;
                let id = self.id("circle");
                let curve = self.insert_geometry(
                    id.clone(),
                    SketchGeometry::Circle {
                        center: center.id.clone(),
                        radius: p.diameter / 2.,
                    },
                    p.construction,
                );
                PrimitiveData::Circle(CircleData {
                    id,
                    points: vec![center],
                    curves: vec![curve],
                    constraints: vec![],
                })
            }
            Primitive::Arc(p) => PrimitiveData::Geometry(self.add_arc(p)?),
            Primitive::Ellipse(p) => {
                finite(&[p.major, p.minor, p.angle])?;
                if p.major <= LINEAR_TOLERANCE || p.minor <= LINEAR_TOLERANCE {
                    return Err(invalid("Ellipse requires positive semiaxes"));
                }
                let center = self.add_point(p.center, p.construction)?;
                let id = self.id("ellipse");
                let curve = self.insert_geometry(
                    id.clone(),
                    SketchGeometry::Ellipse {
                        center: center.id.clone(),
                        major: p.major,
                        minor: p.minor,
                        angle: p.angle.to_radians(),
                    },
                    p.construction,
                );
                let (s, c) = p.angle.to_radians().sin_cos();
                let mut points = vec![center];
                let mut curves = vec![curve];
                let mut axes = [None, None];
                for (index, vector) in [[p.major * c, p.major * s], [-p.minor * s, p.minor * c]]
                    .into_iter()
                    .enumerate()
                {
                    let axis = self.add_line(
                        [p.center[0] - vector[0], p.center[1] - vector[1]],
                        [p.center[0] + vector[0], p.center[1] + vector[1]],
                        true,
                    )?;
                    axes[index] = Some(axis.curves[0].id.clone());
                    points.extend(axis.points);
                    curves.extend(axis.curves);
                }
                self.ellipse_axes.insert(id.clone(), axes);
                PrimitiveData::Geometry(GeometryData {
                    id,
                    points,
                    curves,
                    constraints: vec![],
                })
            }
            Primitive::Slot(p) => {
                finite(&[p.radius])?;
                if p.radius <= LINEAR_TOLERANCE {
                    return Err(invalid("Slot requires a positive radius"));
                }
                let dx = p.to[0] - p.from[0];
                let dy = p.to[1] - p.from[1];
                let distance = dx.hypot(dy);
                if distance <= LINEAR_TOLERANCE {
                    return Err(invalid("Slot centers must differ"));
                }
                let angle = dy.atan2(dx).to_degrees();
                let side = [-dy / distance * p.radius, dx / distance * p.radius];
                let id = self.id("slot");
                let mut points = vec![];
                let mut curves = vec![];
                let mut constraints = vec![];
                let a = self.add_arc(ArcParameters {
                    center: p.to,
                    radius: p.radius,
                    start: angle - 90.,
                    end: angle + 90.,
                    construction: p.construction,
                })?;
                let b = self.add_arc(ArcParameters {
                    center: p.from,
                    radius: p.radius,
                    start: angle + 90.,
                    end: angle + 270.,
                    construction: p.construction,
                })?;
                let top = self.add_line(
                    [p.to[0] + side[0], p.to[1] + side[1]],
                    [p.from[0] + side[0], p.from[1] + side[1]],
                    p.construction,
                )?;
                let bottom = self.add_line(
                    [p.from[0] - side[0], p.from[1] - side[1]],
                    [p.to[0] - side[0], p.to[1] - side[1]],
                    p.construction,
                )?;
                for pair in [
                    vec![a.points[2].clone(), top.points[0].clone()],
                    vec![top.points[1].clone(), b.points[1].clone()],
                    vec![b.points[2].clone(), bottom.points[0].clone()],
                    vec![bottom.points[1].clone(), a.points[1].clone()],
                ] {
                    constraints.push(
                        self.add_constraint(
                            ConstraintKind::Coincident,
                            ConstraintParameters {
                                points: pair,
                                curves: vec![],
                            },
                        )?
                        .id,
                    );
                }
                for pair in [
                    vec![a.curves[0].clone(), top.curves[0].clone()],
                    vec![b.curves[0].clone(), top.curves[0].clone()],
                    vec![a.curves[0].clone(), bottom.curves[0].clone()],
                    vec![b.curves[0].clone(), bottom.curves[0].clone()],
                ] {
                    constraints.push(
                        self.add_constraint(
                            ConstraintKind::Tangent,
                            ConstraintParameters {
                                points: vec![],
                                curves: pair,
                            },
                        )?
                        .id,
                    );
                }
                constraints.push(
                    self.add_constraint(
                        ConstraintKind::Equal,
                        ConstraintParameters {
                            points: vec![],
                            curves: vec![a.curves[0].clone(), b.curves[0].clone()],
                        },
                    )?
                    .id,
                );
                let axis_id = self.id("line");
                let axis = self.insert_geometry(
                    axis_id,
                    SketchGeometry::Line {
                        from: a.points[0].id.clone(),
                        to: b.points[0].id.clone(),
                    },
                    true,
                );
                for data in [a, top, b, bottom] {
                    points.extend(data.points);
                    curves.extend(data.curves);
                }
                let center = self.add_point(
                    [(p.from[0] + p.to[0]) / 2., (p.from[1] + p.to[1]) / 2.],
                    true,
                )?;
                constraints.push(
                    self.add_constraint(
                        ConstraintKind::Midpoint,
                        ConstraintParameters {
                            points: vec![center.clone()],
                            curves: vec![axis.clone()],
                        },
                    )?
                    .id,
                );
                points.push(center);
                curves.push(axis);
                PrimitiveData::Geometry(GeometryData {
                    id,
                    points,
                    curves,
                    constraints,
                })
            }
            Primitive::Spline(p) => PrimitiveData::Geometry(self.add_spline(p)?),
        })
    }
}
