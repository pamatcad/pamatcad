use crate::{
    error::{CoreError, ErrorCode, Result},
    kernel::{PrismOptions, PrismSide},
    model::{Body, Scene},
    protocol::*,
    sketch::{Frame, LINEAR_TOLERANCE},
};

fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}

impl ExtrudeParameters {
    pub(crate) fn extrusion_type(&self) -> ExtrudeType {
        self.r#type.unwrap_or_default()
    }

    pub(crate) fn resolve<'a>(
        &mut self,
        scene: &'a Scene,
        frame: Frame,
        targets: &[&Body],
    ) -> Result<PrismOptions<'a>> {
        let kind = self.extrusion_type();
        if kind != ExtrudeType::TwoSides
            && (self.length2.is_some() || self.extent2.is_some() || self.taper_angle2.is_some())
        {
            return Err(invalid("Side 2 parameters require a two-sided extrusion"));
        }
        if kind != ExtrudeType::Symmetric && self.symmetric_length.is_some() {
            return Err(invalid(
                "The total/half length switch requires a symmetric extrusion",
            ));
        }
        let units = scene.data.units;
        let offset = match &mut self.start {
            None | Some(ExtrudeStart::ProfilePlane) => 0.,
            Some(ExtrudeStart::Offset { offset }) => {
                offset.resolve_in_scene(scene, units.length)?
            }
            Some(ExtrudeStart::Object { face }) => {
                let (body, slot) = scene.resolve_face(face)?;
                let [min, max] = body.shape.axial_bounds(Some(slot), frame)?;
                if min > 0. {
                    min
                } else if max < 0. {
                    max
                } else {
                    0.
                }
            }
        };
        if !offset.is_finite() {
            return Err(invalid("Start offset must be finite"));
        }
        let start = Frame {
            origin: std::array::from_fn(|i| frame.origin[i] + offset * frame.normal[i]),
            ..frame
        };
        let sign = if self.direction == Some(ExtrudeDirection::Negative) {
            -1.
        } else {
            1.
        };
        let first_length = self
            .length1
            .as_mut()
            .map(|formula| formula.resolve_in_scene(scene, units.length))
            .transpose()?;
        let first_extent = self.extent1.as_ref().unwrap_or(&ExtrudeExtent::Length);
        let first_taper = self
            .taper_angle1
            .as_mut()
            .map(|formula| formula.resolve_in_scene(scene, units.angle))
            .transpose()?
            .unwrap_or(0.);
        let make_side = |extent: &ExtrudeExtent,
                         length: Option<f64>,
                         direction: f64,
                         taper: f64|
         -> Result<PrismSide<'a>> {
            if !taper.is_finite() || taper.abs() >= 90. {
                return Err(invalid("Taper angle must be between -90 and 90 degrees"));
            }
            if !matches!(extent, ExtrudeExtent::Length) && length.is_some() {
                return Err(invalid("Only a length extent accepts a length"));
            }
            match extent {
                ExtrudeExtent::Length => {
                    let value =
                        length.ok_or_else(|| invalid("A length extent requires a length"))?;
                    if !value.is_finite() || value.abs() <= LINEAR_TOLERANCE {
                        return Err(invalid("Length must be finite and nonzero"));
                    }
                    Ok(PrismSide::new(None, direction * value, taper, 0))
                }
                ExtrudeExtent::ThroughAll => {
                    let mut reach = 0_f64;
                    for body in targets {
                        let [min, max] = body.shape.axial_bounds(None, start)?;
                        reach = reach.max(if direction > 0. { max } else { -min });
                    }
                    if reach <= LINEAR_TOLERANCE {
                        return Err(invalid("Through-all has no forward body"));
                    }
                    let margin = if self.mode == Some(ExtrudeMode::Cut) {
                        10. * LINEAR_TOLERANCE
                    } else {
                        0.
                    };
                    Ok(PrismSide::new(None, direction * (reach + margin), taper, 0))
                }
                ExtrudeExtent::ToObject { body, extent } => {
                    if body.scene_id != scene.data.id {
                        return Err(invalid("Limiting body belongs to another scene"));
                    }
                    let target = scene.bodies.get(&body.id).ok_or_else(|| {
                        CoreError::new(ErrorCode::NotFound, "Limiting body does not exist")
                    })?;
                    let code = match extent {
                        ObjectExtent::Closest => 1,
                        ObjectExtent::Touch => 2,
                        ObjectExtent::Intersect => 3,
                        ObjectExtent::Farthest => 4,
                    };
                    Ok(PrismSide::new(Some(&target.shape), direction, taper, code))
                }
            }
        };
        let sides = match kind {
            ExtrudeType::OneSide => {
                let side = make_side(first_extent, first_length, sign, first_taper)?;
                [side, side]
            }
            ExtrudeType::TwoSides => [
                make_side(first_extent, first_length, sign, first_taper)?,
                make_side(
                    self.extent2.as_ref().unwrap_or(&ExtrudeExtent::Length),
                    self.length2
                        .as_mut()
                        .map(|formula| formula.resolve_in_scene(scene, units.length))
                        .transpose()?,
                    -sign,
                    self.taper_angle2
                        .as_mut()
                        .map(|formula| formula.resolve_in_scene(scene, units.angle))
                        .transpose()?
                        .unwrap_or(0.),
                )?,
            ],
            ExtrudeType::Symmetric => {
                if !matches!(first_extent, ExtrudeExtent::Length) {
                    return Err(invalid("Symmetric extrusion requires a length extent"));
                }
                let each = first_length.map(|l| {
                    if self.symmetric_length == Some(SymmetricLength::Half) {
                        l
                    } else {
                        l / 2.
                    }
                });
                [
                    make_side(first_extent, each, sign, first_taper)?,
                    make_side(first_extent, each, -sign, first_taper)?,
                ]
            }
        };
        Ok(PrismOptions {
            normal: frame.normal,
            origin: frame.origin,
            offset,
            sides,
            two_sides: (kind != ExtrudeType::OneSide).into(),
        })
    }
}
