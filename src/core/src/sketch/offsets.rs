use super::*;
use std::collections::BTreeSet;

fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}

impl Sketch {
    pub fn offset_owner(&self, id: &str) -> Option<&SketchOffset> {
        self.offsets.values().find(|offset| {
            offset.id == id
                || format!("{}-fixed", offset.id) == id
                || offset.sides.iter().flatten().any(|r| r.id == id)
        })
    }

    pub fn ensure_offset_editable(&self, id: &str) -> Result<()> {
        if self.offset_owner(id).is_some() {
            return Err(invalid(
                "Offset geometry is linked; edit its offset distance or source",
            ));
        }
        Ok(())
    }

    pub fn offset_dependencies(&self) -> impl Iterator<Item = &SketchEntityRef> {
        self.offsets.values().flat_map(|offset| {
            std::iter::once(&offset.distance1)
                .chain(offset.distance2.iter())
                .flat_map(|f| match f {
                    Formula::Evaluated(e) => e.references.as_slice(),
                    _ => &[],
                })
                .map(|r| &r.dimension)
        })
    }

    pub fn set_offset(
        &mut self,
        id: Option<String>,
        sources: Vec<SketchEntityRef>,
        mode: SketchOffsetMode,
        mut distance1: Formula<LengthUnit>,
        mut distance2: Option<Formula<LengthUnit>>,
        annotations: Option<[Option<DimensionAnnotation>; 2]>,
        units: SceneUnits,
        external: &BTreeMap<String, (SketchEntityRef, FormulaQuantity<FormulaUnit>)>,
    ) -> Result<SketchEditResult> {
        let previous = id
            .as_ref()
            .map(|id| {
                self.offsets
                    .get(id)
                    .cloned()
                    .ok_or_else(|| invalid("Offset does not exist"))
            })
            .transpose()?;
        if sources.is_empty() {
            return Err(invalid("Select connected source curves to offset"));
        }
        for r in &sources {
            self.check_reference(r)?;
            self.ensure_spline_helper_editable(&r.id)?;
            self.ensure_text_outline_editable(&r.id)?;
            self.ensure_text_frame_editable(&r.id)?;
        }
        if previous.as_ref().is_some_and(|old| old.sources != sources) {
            return Err(invalid("Offset edits must retain their source curves"));
        }
        if mode == SketchOffsetMode::Independent && distance2.is_none() {
            return Err(invalid("Independent offset requires two distances"));
        }
        // Reopening an unchanged expression must retain renamed references and implicit units.
        if let Some(old) = &previous {
            for (next, saved) in std::iter::once((&mut distance1, &old.distance1))
                .chain(distance2.iter_mut().zip(old.distance2.iter()))
            {
                if let (Formula::Expression(source), Formula::Evaluated(bound)) = (&*next, saved) {
                    if source == &bound.expression {
                        *next = saved.clone();
                    }
                }
            }
        }
        let id = id.unwrap_or_else(|| self.id("offset"));
        let annotations = annotations.unwrap_or_else(|| previous.as_ref()
            .map(|o| o.annotations.clone()).unwrap_or_default());
        if annotations.iter().flatten().any(|a| a.position.iter().any(|v| !v.is_finite())) {
            return Err(invalid("Offset annotation coordinates must be finite"));
        }
        let old = previous.map(|o| o.sides).unwrap_or_default();
        self.offsets.insert(
            id.clone(),
            SketchOffset {
                id: id.clone(),
                sources,
                sides: old.clone(),
                mode,
                distance1,
                annotations,
                distance2: if mode == SketchOffsetMode::Independent {
                    distance2
                } else {
                    None
                },
            },
        );
        self.refresh_offsets(units, external, self.auto_recompute)?;
        let generated = self.offsets[&id]
            .sides
            .iter()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        Ok(SketchEditResult {
            created: generated
                .iter()
                .filter(|r| {
                    !old.iter().flatten().any(|o| o == *r)
                        && !matches!(self.entities[&r.id].geometry, SketchGeometry::Point { .. })
                })
                .cloned()
                .collect(),
            removed: old
                .into_iter()
                .flatten()
                .filter(|r| !generated.contains(r))
                .collect(),
            removed_constraints: vec![],
            removed_dimensions: vec![],
        })
    }

    pub fn refresh_offsets(
        &mut self,
        units: SceneUnits,
        external: &BTreeMap<String, (SketchEntityRef, FormulaQuantity<FormulaUnit>)>,
        recompute: bool,
    ) -> Result<()> {
        let mut pending = self.offsets.keys().cloned().collect::<BTreeSet<_>>();
        while !pending.is_empty() {
            let mut progressed = false;
            for id in pending.clone() {
                let mut offset = self.offsets[&id].clone();
                let mut dependencies = offset
                    .sources
                    .iter()
                    .filter_map(|r| self.offset_owner(&r.id))
                    .map(|o| o.id.clone())
                    .collect::<BTreeSet<_>>();
                for formula in
                    std::iter::once(&mut offset.distance1).chain(offset.distance2.iter_mut())
                {
                    let saved = match formula {
                        Formula::Evaluated(e) => e.references.clone(),
                        _ => vec![],
                    };
                    let mut references = vec![];
                    let mut evaluated = crate::formula::FormulaEvaluator::evaluate_with(
                        formula,
                        units.length,
                        &mut |symbol| {
                            let bound = saved
                                .iter()
                                .find(|r| r.symbol == symbol)
                                .map(|r| &r.dimension);
                            let local = self.dimensions.values().find(|d| {
                                if let Some(r) = bound {
                                    return r.sketch_id == self.data.id && r.id == d.id;
                                }
                                std::iter::once(self.data.id.as_str())
                                    .chain(self.data.name.as_deref())
                                    .any(|sketch| {
                                        std::iter::once(d.id.as_str())
                                            .chain(d.parameters.name.as_deref())
                                            .any(|name| {
                                                symbol
                                                    == format!(
                                                        "sketches[{sketch}]dimension[{name}]"
                                                    )
                                            })
                                    })
                                    || symbol == d.id
                                    || d.parameters.name.as_deref() == Some(symbol)
                            });
                            let (reference, computed) = if let Some(d) = local {
                                let mut dimensions = vec![d.id.clone()];
                                let mut visited = BTreeSet::new();
                                while let Some(id) = dimensions.pop() {
                                    if !visited.insert(id.clone()) {
                                        continue;
                                    }
                                    let d = &self.dimensions[&id];
                                    for r in d
                                        .parameters
                                        .points
                                        .iter()
                                        .chain(&d.parameters.curves)
                                        .chain(d.parameters.line.iter())
                                        .chain(d.parameters.curve.iter())
                                    {
                                        if let Some(owner) = self.offset_owner(&r.id) {
                                            dependencies.insert(owner.id.clone());
                                        }
                                    }
                                    dimensions.extend(
                                        d.dependencies
                                            .iter()
                                            .filter(|r| r.sketch_id == self.data.id)
                                            .map(|r| r.id.clone()),
                                    );
                                }
                                (self.entity_ref(&d.id), d.computed.clone())
                            } else {
                                if let Some(r) = bound {
                                    external.values().find(|(id, _)| id == r)
                                } else {
                                    external.get(symbol)
                                }
                                .cloned()
                                .ok_or_else(|| {
                                    invalid("Offset distance references an unknown dimension")
                                })?
                            };
                            references.push(FormulaReference {
                                symbol: symbol.to_owned(),
                                dimension: reference,
                            });
                            Ok(crate::formula::Quantity {
                                expression: crate::formula::Expression::number(
                                    computed.value * computed.unit.scale(),
                                ),
                                powers: computed.unit.dimension().powers(),
                            })
                        },
                    )?;
                    evaluated.references = references;
                    *formula = Formula::Evaluated(evaluated);
                }
                if dependencies
                    .iter()
                    .any(|dependency| pending.contains(dependency))
                {
                    continue;
                }
                let value = |formula: &Formula<LengthUnit>| {
                    let Formula::Evaluated(e) = formula else {
                        unreachable!()
                    };
                    let value = e.computed.value * FormulaUnit::Length(e.computed.unit).scale();
                    if value.abs() < LINEAR_TOLERANCE {
                        Err(invalid("Offset distances must be nonzero"))
                    } else {
                        Ok(value)
                    }
                };
                let first = value(&offset.distance1)?;
                let values = match offset.mode {
                    SketchOffsetMode::OneSided => vec![first],
                    SketchOffsetMode::Symmetric => vec![first, -first],
                    SketchOffsetMode::Independent => {
                        vec![first, -value(offset.distance2.as_ref().unwrap())?]
                    }
                };
                let ids = offset
                    .sources
                    .iter()
                    .map(|r| {
                        self.check_reference(r)?;
                        Ok(r.id.clone())
                    })
                    .collect::<Result<Vec<_>>>()?;
                let source_values = solver::fixed_values(self, &offset.sources)?;
                let mut sides = vec![];
                for (side, value) in values.into_iter().enumerate() {
                    let curves = crate::kernel::sketch::modify(self, &ids, 1, value, None)?;
                    if curves.is_empty() {
                        return Err(invalid("Offset produces no curves"));
                    }
                    let next_id = self.next_id;
                    let mut refs = vec![];
                    for (_, kind, data) in curves {
                        // Rebuilds also refresh completed sketches; only derived imports are editable here.
                        let completed = self.data.completed;
                        self.data.completed = false;
                        let geometry = self.import_curve(kind, &data);
                        self.data.completed = completed;
                        let geometry = geometry?;
                        refs.extend(geometry.points);
                        refs.extend(geometry.curves);
                    }
                    if let Some(old) = offset.sides.get(side) {
                        if old.len() != refs.len() {
                            return Err(invalid(
                                "Offset topology changed; remove and recreate the offset",
                            ));
                        }
                        let remap = refs
                            .iter()
                            .zip(old)
                            .map(|(new, old)| (new.id.clone(), old.id.clone()))
                            .collect::<BTreeMap<_, _>>();
                        for (new, old) in refs.iter().zip(old) {
                            let mut entity = self.entities.remove(&new.id).unwrap();
                            let previous = &self.entities[&old.id];
                            if std::mem::discriminant(&entity.geometry)
                                != std::mem::discriminant(&previous.geometry)
                            {
                                return Err(invalid(
                                    "Offset topology changed; remove and recreate the offset",
                                ));
                            }
                            entity.reference = old.clone();
                            entity.construction = previous.construction;
                            let replace = |id: &mut String| *id = remap[id].clone();
                            match &mut entity.geometry {
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
                            self.entities.insert(old.id.clone(), entity);
                        }
                        refs = old.clone();
                        self.next_id = next_id;
                    }
                    sides.push(refs);
                }
                let fixed = format!("{id}-fixed");
                for r in offset.sides.iter().skip(sides.len()).flatten() {
                    if self.constraints.values().any(|c| {
                        c.id != fixed
                            && c.parameters
                                .points
                                .iter()
                                .chain(&c.parameters.curves)
                                .any(|p| p == r)
                    }) || self.dimensions.values().any(|d| {
                        d.parameters
                            .points
                            .iter()
                            .chain(&d.parameters.curves)
                            .chain(d.parameters.line.iter())
                            .chain(d.parameters.curve.iter())
                            .any(|p| p == r)
                    }) {
                        return Err(invalid("Cannot remove a referenced offset side"));
                    }
                    self.entities.remove(&r.id);
                }
                offset.sides = sides;
                let refs = offset.sides.iter().flatten().cloned().collect::<Vec<_>>();
                self.fixed
                    .insert(fixed.clone(), solver::fixed_values(self, &refs)?);
                self.constraints.insert(
                    fixed.clone(),
                    SketchConstraint {
                        id: fixed,
                        kind: ConstraintKind::Fix,
                        parameters: ConstraintParameters {
                            points: refs
                                .iter()
                                .filter(|r| {
                                    matches!(
                                        self.entities[&r.id].geometry,
                                        SketchGeometry::Point { .. }
                                    )
                                })
                                .cloned()
                                .collect(),
                            curves: refs
                                .iter()
                                .filter(|r| {
                                    !matches!(
                                        self.entities[&r.id].geometry,
                                        SketchGeometry::Point { .. }
                                    )
                                })
                                .cloned()
                                .collect(),
                        },
                    },
                );
                self.offsets.insert(id.clone(), offset);
                // Update downstream measurements before evaluating the next dependent offset.
                if recompute {
                    solver::solve(self, units, external, &[])?;
                    let solved = solver::fixed_values(self, &self.offsets[&id].sources)?;
                    if source_values.iter().any(|(id, values)| {
                        values
                            .iter()
                            .zip(&solved[id])
                            .any(|(a, b)| (a - b).abs() > LINEAR_TOLERANCE)
                    }) {
                        return Err(invalid(
                            "Offset output constraints cannot change its source geometry",
                        ));
                    }
                }
                pending.remove(&id);
                progressed = true;
            }
            if !progressed {
                return Err(invalid("Offset dependency cycle"));
            }
        }
        Ok(())
    }
}
