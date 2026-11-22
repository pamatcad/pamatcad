use super::*;
use base64::Engine as _;
use ttf_parser::OutlineBuilder;
fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}
#[derive(Default)]
struct Outline {
    segments: Vec<Vec<[f64; 2]>>,
    current: [f64; 2],
    start: [f64; 2],
}
impl OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.current = [x as f64, y as f64];
        self.start = self.current;
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let end = [x as f64, y as f64];
        if self.current != end {
            self.segments.push(vec![self.current, end]);
        }
        self.current = end;
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let end = [x as f64, y as f64];
        self.segments
            .push(vec![self.current, [x1 as f64, y1 as f64], end]);
        self.current = end;
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let end = [x as f64, y as f64];
        self.segments.push(vec![
            self.current,
            [x1 as f64, y1 as f64],
            [x2 as f64, y2 as f64],
            end,
        ]);
        self.current = end;
    }
    fn close(&mut self) {
        if self.current != self.start {
            self.segments.push(vec![self.current, self.start]);
        }
        self.current = self.start;
    }
}
impl Sketch {
    pub fn add_text(&mut self, p: TextParameters) -> Result<GeometryData> {
        let size = if let Formula::Number(n) = p.size {
            n
        } else {
            return Err(invalid(
                "Text size must be evaluated before constructing outlines",
            ));
        };
        if !size.is_finite() || size <= 0. || p.text.len() > 16384 {
            return Err(invalid(
                "Text requires a positive size and at most 16384 bytes",
            ));
        }
        let imported = p
            .font_base64
            .map(|s| {
                base64::engine::general_purpose::STANDARD
                    .decode(s)
                    .map_err(|_| invalid("Invalid font encoding"))
            })
            .transpose()?;
        let bytes = imported
            .as_deref()
            .unwrap_or(include_bytes!("../../../../native/sketch/fonts/Roboto.ttf"));
        let mut face = rustybuzz::Face::from_slice(bytes, 0)
            .ok_or_else(|| invalid("Invalid OpenType/TrueType font"))?;
        face.set_variations(&[rustybuzz::Variation {
            tag: ttf_parser::Tag::from_bytes(b"wght"),
            value: p.weight.unwrap_or(400.),
        }]);
        let scale = size / face.units_per_em() as f64;
        let mut buffer = rustybuzz::UnicodeBuffer::new();
        buffer.push_str(&p.text);
        buffer.guess_segment_properties();
        let glyphs = rustybuzz::shape(&face, &[], buffer);
        let width = glyphs
            .glyph_positions()
            .iter()
            .map(|p| p.x_advance as f64)
            .sum::<f64>()
            * scale;
        let mut x = match p.horizontal {
            TextHorizontalAlign::Left => 0.,
            TextHorizontalAlign::Center => -width / 2.,
            TextHorizontalAlign::Right => -width,
        };
        let y = match p.vertical {
            TextVerticalAlign::Baseline => 0.,
            TextVerticalAlign::Bottom => -(face.descender() as f64) * scale,
            TextVerticalAlign::Top => -(face.ascender() as f64) * scale,
            TextVerticalAlign::Middle => {
                -(face.ascender() as f64 + face.descender() as f64) * scale / 2.
            }
        };
        let guide = if let Some(reference) = &p.guide {
            self.check_reference(reference)?;
            Some(self.curve_samples(&reference.id, 256)?)
        } else {
            None
        };
        let mut distances = vec![0.];
        if let Some(guide) = &guide {
            for pair in guide.windows(2) {
                distances.push(
                    distances.last().unwrap()
                        + (pair[1][0] - pair[0][0]).hypot(pair[1][1] - pair[0][1]),
                );
            }
        }
        if let Some(guide) = &guide {
            if guide.len() < 2 {
                return Err(invalid("Text guideline has no length"));
            }
            let mut nearest = (f64::INFINITY, 0.);
            for (index, pair) in guide.windows(2).enumerate() {
                let a = pair[0];
                let b = pair[1];
                let delta = [b[0] - a[0], b[1] - a[1]];
                let square = delta[0] * delta[0] + delta[1] * delta[1];
                if square <= 1e-20 {
                    continue;
                }
                let t = (((p.origin[0] - a[0]) * delta[0] + (p.origin[1] - a[1]) * delta[1])
                    / square)
                    .clamp(0., 1.);
                let distance =
                    (p.origin[0] - a[0] - t * delta[0]).hypot(p.origin[1] - a[1] - t * delta[1]);
                if distance < nearest.0 {
                    nearest = (distance, distances[index] + t * square.sqrt());
                }
            }
            x += nearest.1;
            if x < -1e-7 || x + width > distances.last().unwrap() + 1e-7 {
                return Err(invalid("Text extends beyond its guideline"));
            }
            x = x.max(0.);
        }
        let id = self.id("text");
        let mut points = vec![];
        let mut curves = vec![];
        for (info, position) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
            if info.glyph_id == 0 {
                return Err(invalid(
                    "The selected font has no glyph for part of this text",
                ));
            }
            let mut outline = Outline::default();
            face.outline_glyph(ttf_parser::GlyphId(info.glyph_id as u16), &mut outline);
            let offset = [
                x + position.x_offset as f64 * scale,
                y + position.y_offset as f64 * scale,
            ];
            let (origin, angle) = if let Some(guide) = &guide {
                if x < 0. || x > *distances.last().unwrap() {
                    return Err(invalid("Text extends beyond its guideline"));
                }
                let index = distances
                    .partition_point(|d| *d <= x)
                    .saturating_sub(1)
                    .min(guide.len() - 2);
                let a = guide[index];
                let b = guide[index + 1];
                let t = (x - distances[index]) / (distances[index + 1] - distances[index]);
                (
                    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
                    (b[1] - a[1]).atan2(b[0] - a[0]),
                )
            } else {
                (p.origin, 0.)
            };
            for segment in outline.segments {
                let positions = segment
                    .into_iter()
                    .map(|q| {
                        let u = q[0] * scale + offset[0] - if guide.is_some() { x } else { 0. };
                        let v = q[1] * scale + offset[1];
                        [
                            origin[0] + u * angle.cos() - v * angle.sin(),
                            origin[1] + u * angle.sin() + v * angle.cos(),
                        ]
                    })
                    .collect::<Vec<_>>();
                let primitive = if positions.len() == 2 {
                    Primitive::Line(LineParameters {
                        from: positions[0],
                        to: positions[1],
                        construction: p.construction,
                    })
                } else {
                    Primitive::Spline(SplineParameters {
                        degree: Some(positions.len() - 1),
                        points: positions,
                        fit: false,
                        closed: false,
                        construction: p.construction,
                    })
                };
                if let PrimitiveData::Geometry(data) = self.add_primitive(primitive)? {
                    points.extend(data.points);
                    curves.extend(data.curves);
                }
            }
            x += position.x_advance as f64 * scale;
        }
        if !curves.is_empty() {
            let normalized = crate::kernel::sketch::modify(
                self,
                &curves.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
                3,
                0.,
            )?;
            for reference in points.iter().chain(&curves) {
                self.entities.remove(&reference.id);
            }
            points.clear();
            curves.clear();
            for (_, kind, data) in normalized {
                let geometry = self.import_curve(kind, &data)?;
                points.extend(geometry.points);
                curves.extend(geometry.curves);
            }
        }
        for reference in points.iter().chain(&curves) {
            self.entities.get_mut(&reference.id).unwrap().construction = p.construction;
        }
        let constraint = self.add_constraint(
            ConstraintKind::Fix,
            ConstraintParameters {
                points: vec![],
                curves: curves.clone(),
            },
        )?;
        Ok(GeometryData {
            id,
            points,
            curves,
            constraints: vec![constraint.id],
        })
    }
}
