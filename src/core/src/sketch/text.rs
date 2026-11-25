use super::*;
mod cache;
use base64::Engine as _;
pub(crate) use cache::GlyphCache;
use cache::{normalize_glyphs, PlacedGlyph};
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
impl SketchTextFrame {
    pub(crate) fn references(&self) -> [&SketchEntityRef; 11] {
        [
            &self.bottom_left,
            &self.bottom_right,
            &self.top_right,
            &self.top_left,
            &self.center,
            &self.bottom,
            &self.right,
            &self.top,
            &self.left,
            &self.diagonal1,
            &self.diagonal2,
        ]
    }
}
impl Sketch {
    fn add_text_frame(&mut self) -> Result<SketchTextFrame> {
        let bottom_left = self.add_point([0., 0.], true)?;
        let bottom_right = self.add_point([0., 0.], true)?;
        let top_right = self.add_point([0., 0.], true)?;
        let top_left = self.add_point([0., 0.], true)?;
        let center = self.add_point([0., 0.], true)?;
        let mut line = |a: &SketchEntityRef, b: &SketchEntityRef| {
            let id = self.id("line");
            let reference = self.insert_geometry(
                id,
                SketchGeometry::Line {
                    from: a.id.clone(),
                    to: b.id.clone(),
                },
                true,
            );
            self.entities.get_mut(&reference.id).unwrap().allow_collapse = true;
            reference
        };
        Ok(SketchTextFrame {
            bottom: line(&bottom_left, &bottom_right),
            right: line(&bottom_right, &top_right),
            top: line(&top_left, &top_right),
            left: line(&bottom_left, &top_left),
            diagonal1: line(&bottom_left, &top_right),
            diagonal2: line(&bottom_right, &top_left),
            bottom_left,
            bottom_right,
            top_right,
            top_left,
            center,
        })
    }

    fn reset_text_frame(&mut self, id: &str) {
        let text = &self.texts[id];
        let Some(frame) = &text.frame else { return };
        let [[x0, y0], [x1, y1]] = text.layout;
        for (reference, [x, y]) in [
            (&frame.bottom_left, [x0, y0]),
            (&frame.bottom_right, [x1, y0]),
            (&frame.top_right, [x1, y1]),
            (&frame.top_left, [x0, y1]),
            (&frame.center, [(x0 + x1) / 2., (y0 + y1) / 2.]),
        ] {
            self.entities.get_mut(&reference.id).unwrap().geometry = SketchGeometry::Point {
                position: [
                    text.parameters.origin[0] + x * text.angle.cos() - y * text.angle.sin(),
                    text.parameters.origin[1] + x * text.angle.sin() + y * text.angle.cos(),
                ],
            };
        }
    }

    pub(crate) fn text_frame_owner(&self, id: &str) -> Option<&SketchText> {
        self.texts.values().find(|t| {
            t.frame
                .as_ref()
                .is_some_and(|f| f.references().iter().any(|r| r.id == id))
        })
    }

    pub(crate) fn ensure_text_frame_editable(&self, id: &str) -> Result<()> {
        if self.text_frame_owner(id).is_some() {
            Err(invalid("Text frame geometry is controlled by its text; convert it to sketch geometry first"))
        } else {
            Ok(())
        }
    }

    // Glyphs stay outside the placement solve. Apply the solved rigid pose to their exact
    // control points and refresh the internal fixed values for the next solve.
    pub(crate) fn sync_text_frames(&mut self) -> Result<()> {
        for text in self.texts.values().cloned().collect::<Vec<_>>() {
            let Some(frame) = &text.frame else { continue };
            let a = self.point_position(&frame.bottom_left.id)?;
            let b = self.point_position(&frame.top_left.id)?;
            let angle = (b[1] - a[1]).atan2(b[0] - a[0]) - std::f64::consts::FRAC_PI_2;
            let [x, y] = text.layout[0];
            let origin = [
                a[0] - x * angle.cos() + y * angle.sin(),
                a[1] - x * angle.sin() - y * angle.cos(),
            ];
            self.set_text_pose(&text.id, origin, angle)?;
        }
        Ok(())
    }

    fn set_text_pose(&mut self, id: &str, origin: [f64; 2], angle: f64) -> Result<()> {
        let text = self.texts[id].clone();
        let (s, c) = (angle - text.angle).sin_cos();
        for reference in &text.geometry.points {
            if let SketchGeometry::Point { position } =
                &mut self.entities.get_mut(&reference.id).unwrap().geometry
            {
                let [x, y] = [
                    position[0] - text.parameters.origin[0],
                    position[1] - text.parameters.origin[1],
                ];
                *position = [origin[0] + x * c - y * s, origin[1] + x * s + y * c];
            }
        }
        for constraint in &text.geometry.constraints {
            self.fixed.insert(
                constraint.clone(),
                solver::fixed_values(self, &text.geometry.curves)?,
            );
        }
        let text = self.texts.get_mut(id).unwrap();
        text.parameters.origin = origin;
        text.angle = angle;
        Ok(())
    }

    pub fn add_text(&mut self, p: TextParameters) -> Result<GeometryData> {
        let started =
            std::env::var_os("PAMATCAD_GEOMETRY_PROFILE").map(|_| std::time::Instant::now());
        let size = text_size(&p.size)?;
        if !size.is_finite()
            || size <= 0.
            || p.text.len() > 16384
            || p.origin.iter().any(|n| !n.is_finite())
        {
            return Err(invalid(
                "Text requires a positive size and at most 16384 bytes",
            ));
        }
        let imported = p
            .font_base64
            .as_ref()
            .map(|s| {
                base64::engine::general_purpose::STANDARD
                    .decode(s)
                    .map_err(|_| invalid("Invalid font encoding"))
            })
            .transpose()?;
        let bytes = imported
            .as_deref()
            .unwrap_or(include_bytes!("../../../../native/sketch/fonts/Roboto.ttf"));
        let mut face = rustybuzz::Face::from_slice(bytes, p.font_index.unwrap_or(0))
            .ok_or_else(|| invalid("Invalid OpenType/TrueType font"))?;
        let weight = p.weight.unwrap_or(f32::from(face.weight().to_number()));
        if !weight.is_finite() || !(1. ..=1000.).contains(&weight) {
            return Err(invalid("Font weight must be between 1 and 1000"));
        }
        let axes = face.variation_axes();
        let weight_axis = axes
            .into_iter()
            .find(|a| a.tag == ttf_parser::Tag::from_bytes(b"wght"));
        if let Some(axis) = weight_axis {
            if weight < axis.min_value || weight > axis.max_value {
                return Err(invalid("The selected font does not support this weight"));
            }
        } else if p.weight.is_some() && weight != f32::from(face.weight().to_number()) {
            return Err(invalid("Select a font face with the requested weight"));
        }
        let italic_axis = axes
            .into_iter()
            .find(|a| a.tag == ttf_parser::Tag::from_bytes(b"ital"));
        let slant_axis = axes
            .into_iter()
            .find(|a| a.tag == ttf_parser::Tag::from_bytes(b"slnt"));
        if p.italic && !face.is_italic() && italic_axis.is_none() && slant_axis.is_none() {
            return Err(invalid("The selected font does not have an italic style"));
        }
        face.set_variations(&[
            rustybuzz::Variation {
                tag: ttf_parser::Tag::from_bytes(b"wght"),
                value: weight,
            },
            rustybuzz::Variation {
                tag: ttf_parser::Tag::from_bytes(b"ital"),
                value: if p.italic { 1. } else { 0. },
            },
            rustybuzz::Variation {
                tag: ttf_parser::Tag::from_bytes(b"slnt"),
                value: if p.italic {
                    slant_axis
                        .map(|a| {
                            if a.min_value < 0. {
                                a.min_value.max(-12.)
                            } else {
                                a.max_value.min(12.)
                            }
                        })
                        .unwrap_or(0.)
                } else {
                    0.
                },
            },
        ]);
        let scale = size / face.units_per_em() as f64;
        let lines = p.text.split('\n').collect::<Vec<_>>();
        if lines.len() > 1 && p.guide.is_some() {
            return Err(invalid("Multiline text cannot follow a guideline"));
        }
        let line_height = (f64::from(face.ascender()) - f64::from(face.descender())
            + f64::from(face.line_gap()))
            * scale;
        let block_bottom =
            f64::from(face.descender()) * scale - line_height * (lines.len() - 1) as f64;
        let block_top = f64::from(face.ascender()) * scale;
        if !block_bottom.is_finite()
            || !block_top.is_finite()
            || block_top - block_bottom <= LINEAR_TOLERANCE
        {
            return Err(invalid(
                "Text font metrics must define a positive layout height",
            ));
        }
        let block_y = match p.vertical {
            TextVerticalAlign::Baseline => 0.,
            TextVerticalAlign::Bottom => -block_bottom,
            TextVerticalAlign::Top => -block_top,
            TextVerticalAlign::Middle => -(block_top + block_bottom) / 2.,
        };
        let mut layout = [[0., block_bottom + block_y], [0., block_top + block_y]];
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
        let font_ms = started.map(|t| t.elapsed().as_secs_f64() * 1000.);
        let id = self.id("text");
        let mut points = vec![];
        let mut curves = vec![];
        let mut outlines = BTreeMap::new();
        let mut placed = vec![];
        for (line_index, line) in lines.iter().enumerate() {
            let mut buffer = rustybuzz::UnicodeBuffer::new();
            buffer.push_str(line.trim_end_matches('\r'));
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
            layout[0][0] = layout[0][0].min(x.min(x + width));
            layout[1][0] = layout[1][0].max(x.max(x + width));
            let y = block_y - line_index as f64 * line_height;
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
                    let distance = (p.origin[0] - a[0] - t * delta[0])
                        .hypot(p.origin[1] - a[1] - t * delta[1]);
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
            for (info, position) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
                if info.glyph_id == 0 {
                    return Err(invalid(
                        "The selected font has no glyph for part of this text",
                    ));
                }
                let outline = outlines.entry(info.glyph_id).or_insert_with(|| {
                    let mut outline = Outline::default();
                    face.outline_glyph(ttf_parser::GlyphId(info.glyph_id as u16), &mut outline);
                    for point in outline.segments.iter_mut().flatten() {
                        point[0] *= scale;
                        point[1] *= scale;
                    }
                    Rc::new(outline)
                });
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
                let u = offset[0] - if guide.is_some() { x } else { 0. };
                let v = offset[1];
                placed.push(PlacedGlyph {
                    outline: outline.clone(),
                    origin: [
                        origin[0] + u * angle.cos() - v * angle.sin(),
                        origin[1] + u * angle.sin() + v * angle.cos(),
                    ],
                    angle,
                });
                x += position.x_advance as f64 * scale;
            }
        }
        let outlines_ms = started.map(|t| t.elapsed().as_secs_f64() * 1000.);
        let (normalized, cache_hits, cache_misses, overlap_groups) =
            normalize_glyphs(&placed, &mut self.glyph_cache.borrow_mut())?;
        for (kind, data) in normalized {
            let geometry = self.import_curve(kind, &data)?;
            points.extend(geometry.points);
            curves.extend(geometry.curves);
        }
        let normalization_ms = started.map(|t| t.elapsed().as_secs_f64() * 1000.);
        for reference in points.iter().chain(&curves) {
            self.entities.get_mut(&reference.id).unwrap().construction = p.construction;
        }
        let constraints = if curves.is_empty() {
            vec![]
        } else {
            vec![
                self.add_constraint(
                    ConstraintKind::Fix,
                    ConstraintParameters {
                        points: vec![],
                        curves: curves.clone(),
                    },
                )?
                .id,
            ]
        };
        let geometry = GeometryData {
            id: id.clone(),
            points,
            curves,
            constraints,
        };
        let frame = if p.guide.is_none() {
            Some(self.add_text_frame()?)
        } else {
            None
        };
        self.texts.insert(
            id.clone(),
            SketchText {
                id,
                parameters: p,
                geometry: geometry.clone(),
                frame,
                layout,
                angle: 0.,
            },
        );
        self.reset_text_frame(&geometry.id);
        if let Some(t) = started {
            eprintln!(
                "{}",
                serde_json::json!({"event":"sketch.text", "fontMs":font_ms.unwrap(),
                "outlinesMs":outlines_ms.unwrap()-font_ms.unwrap(),
                "normalizationMs":normalization_ms.unwrap()-outlines_ms.unwrap(),
                "finalizeMs":t.elapsed().as_secs_f64()*1000.-normalization_ms.unwrap(),
                "glyphCacheHits":cache_hits, "glyphCacheMisses":cache_misses, "overlapGroups":overlap_groups})
            );
        }
        Ok(geometry)
    }

    pub fn refresh_texts(
        &mut self,
        units: SceneUnits,
        external: &BTreeMap<String, (SketchEntityRef, FormulaQuantity<FormulaUnit>)>,
    ) -> Result<bool> {
        if self.texts.is_empty() {
            return Ok(false);
        }
        let mut values = external.clone();
        for d in self.dimensions.values() {
            let value = (self.entity_ref(&d.id), d.computed.clone());
            for sketch in std::iter::once(self.data.id.as_str()).chain(self.data.name.as_deref()) {
                for dimension in std::iter::once(d.id.as_str()).chain(d.parameters.name.as_deref())
                {
                    values.insert(
                        format!("sketches[{sketch}]dimension[{dimension}]"),
                        value.clone(),
                    );
                }
            }
            values.insert(format!("{}{}", self.data.id, d.id), value);
        }
        let mut changed = false;
        for text in self.texts.values().cloned().collect::<Vec<_>>() {
            let saved = match &text.parameters.size {
                Formula::Evaluated(e) => e.references.as_slice(),
                _ => &[],
            };
            let mut references = vec![];
            let mut evaluated = crate::formula::FormulaEvaluator::evaluate_with(
                &text.parameters.size,
                units.length,
                &mut |symbol| {
                    let found = if let Some(bound) = saved.iter().find(|r| r.symbol == symbol) {
                        values.values().find(|(r, _)| r == &bound.dimension)
                    } else {
                        values.get(symbol)
                    }
                    .ok_or_else(|| invalid("Text size references an unknown dimension"))?;
                    references.push(FormulaReference {
                        symbol: symbol.to_owned(),
                        dimension: found.0.clone(),
                    });
                    Ok(crate::formula::Quantity {
                        expression: crate::formula::Expression::number(
                            found.1.value * found.1.unit.scale(),
                        ),
                        powers: found.1.unit.dimension().powers(),
                    })
                },
            )?;
            evaluated.references = references;
            let mut parameters = text.parameters.clone();
            parameters.size = Formula::Evaluated(evaluated);
            if (text_size(&parameters.size)? - text_size(&text.parameters.size)?).abs() > 1e-12 {
                self.update_text(&text.id, parameters)?;
                changed = true;
            } else {
                self.texts.get_mut(&text.id).unwrap().parameters.size = parameters.size;
            }
        }
        Ok(changed)
    }

    pub fn text_owner(&self, id: &str) -> Option<&SketchText> {
        self.texts.values().find(|t| {
            t.geometry
                .points
                .iter()
                .chain(&t.geometry.curves)
                .any(|r| r.id == id)
                || t.geometry.constraints.iter().any(|c| c == id)
        })
    }

    pub fn ensure_text_outline_editable(&self, id: &str) -> Result<()> {
        if self.text_owner(id).is_some() {
            Err(invalid(
                "Text outlines are owned by a text object; convert it to sketch geometry first",
            ))
        } else {
            Ok(())
        }
    }

    pub fn explode_text(&mut self, id: &str) -> Result<GeometryData> {
        let text = self
            .texts
            .remove(id)
            .ok_or_else(|| invalid("Text object does not exist"))?;
        let mut geometry = text.geometry;
        for constraint in &geometry.constraints {
            self.constraints.remove(constraint);
            self.fixed.remove(constraint);
        }
        geometry.constraints.clear();
        Ok(geometry)
    }

    pub fn update_text(&mut self, id: &str, parameters: TextParameters) -> Result<SketchText> {
        let previous = self
            .texts
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("Text object does not exist"))?;
        // A size/origin/construction edit is an exact affine change. Retain every boundary ID.
        let mut old = serde_json::to_value(&previous.parameters).unwrap();
        let mut new = serde_json::to_value(&parameters).unwrap();
        for value in [&mut old, &mut new] {
            let fields = value.as_object_mut().unwrap();
            for key in ["size", "origin", "construction"] {
                fields.remove(key);
            }
        }
        let size = text_size(&parameters.size)?;
        if !size.is_finite() || size <= 0. || parameters.origin.iter().any(|v| !v.is_finite()) {
            return Err(invalid("Text requires a finite origin and positive size"));
        }
        if old == new && parameters.guide.is_none() {
            let scale = size / text_size(&previous.parameters.size)?;
            for reference in &previous.geometry.points {
                if let SketchGeometry::Point { position } =
                    &mut self.entities.get_mut(&reference.id).unwrap().geometry
                {
                    for i in 0..2 {
                        position[i] = parameters.origin[i]
                            + (position[i] - previous.parameters.origin[i]) * scale;
                    }
                }
            }
            for reference in previous
                .geometry
                .points
                .iter()
                .chain(&previous.geometry.curves)
            {
                self.entities.get_mut(&reference.id).unwrap().construction =
                    parameters.construction;
            }
            for constraint in &previous.geometry.constraints {
                self.fixed.insert(
                    constraint.clone(),
                    solver::fixed_values(self, &previous.geometry.curves)?,
                );
            }
            let text = self.texts.get_mut(id).unwrap();
            text.parameters = parameters;
            for point in &mut text.layout {
                for value in point {
                    *value *= scale;
                }
            }
            self.reset_text_frame(id);
            return Ok(self.texts[id].clone());
        }
        let geometry = self.explode_text(id)?;
        // Do not silently delete external relations or reattach them to unrelated glyph edges.
        if self.constraints.values().any(|c| {
            c.parameters
                .points
                .iter()
                .chain(&c.parameters.curves)
                .any(|r| {
                    geometry
                        .points
                        .iter()
                        .chain(&geometry.curves)
                        .any(|p| p.id == r.id)
                })
        }) || self.dimensions.values().any(|d| {
            d.parameters
                .points
                .iter()
                .chain(&d.parameters.curves)
                .chain(d.parameters.line.iter())
                .chain(d.parameters.curve.iter())
                .any(|r| {
                    geometry
                        .points
                        .iter()
                        .chain(&geometry.curves)
                        .any(|p| p.id == r.id)
                })
        }) {
            return Err(invalid(
                "Text topology change would invalidate an outline reference",
            ));
        }
        for r in geometry.points.iter().chain(&geometry.curves) {
            self.entities.remove(&r.id);
        }
        let generated = self.add_text(parameters)?;
        let mut text = self.texts.remove(&generated.id).unwrap();
        if let Some(frame) = &previous.frame {
            if text.frame.is_some() {
                for r in text.frame.as_ref().unwrap().references() {
                    self.entities.remove(&r.id);
                }
                text.frame = Some(frame.clone());
            } else {
                let ids = frame.references().map(|r| r.id.as_str());
                if self.constraints.values().any(|c| {
                    c.parameters
                        .points
                        .iter()
                        .chain(&c.parameters.curves)
                        .any(|r| ids.contains(&r.id.as_str()))
                }) || self.dimensions.values().any(|d| {
                    d.parameters
                        .points
                        .iter()
                        .chain(&d.parameters.curves)
                        .chain(d.parameters.line.iter())
                        .chain(d.parameters.curve.iter())
                        .any(|r| ids.contains(&r.id.as_str()))
                }) {
                    return Err(invalid(
                        "Remove text-frame constraints and dimensions before assigning a guideline",
                    ));
                }
                for r in frame.references() {
                    self.entities.remove(&r.id);
                }
            }
        }
        text.id = id.to_owned();
        text.geometry.id = id.to_owned();
        self.texts.insert(id.to_owned(), text);
        if self.texts[id].frame.is_some() {
            self.set_text_pose(id, self.texts[id].parameters.origin, previous.angle)?;
            self.reset_text_frame(id);
        }
        Ok(self.texts[id].clone())
    }
}

fn text_size(formula: &Formula<LengthUnit>) -> Result<f64> {
    match formula {
        Formula::Number(n) => Ok(*n),
        Formula::Evaluated(e) => {
            Ok(e.computed.value * FormulaUnit::Length(e.computed.unit).scale())
        }
        _ => Err(invalid(
            "Text size must be evaluated before constructing outlines",
        )),
    }
}
