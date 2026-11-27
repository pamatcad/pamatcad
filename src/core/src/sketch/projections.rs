use super::*;
impl Sketch {
    pub fn set_projection(
        &mut self,
        id: Option<String>,
        source: ProjectionSource,
        curves: Vec<(i32, Vec<f64>)>,
    ) -> Result<SketchProjection> {
        let id = id.unwrap_or_else(|| self.id("projection"));
        let previous = self.projections.get(&id).cloned();
        let mut references = vec![];
        for (kind, data) in curves {
            let imported = self.import_curve(kind, &data)?;
            references.extend(imported.points);
            references.extend(imported.curves);
        }
        if let Some(old) = previous {
            if old.entities.len() != references.len() {
                return Err(CoreError::new(
                    ErrorCode::InvalidState,
                    "Projection topology changed; remove and recreate the projection explicitly",
                ));
            }
            let remap = references
                .iter()
                .zip(&old.entities)
                .map(|(new, old)| (new.id.clone(), old.id.clone()))
                .collect::<BTreeMap<_, _>>();
            let mut updated = vec![];
            for (new, old) in references.iter().zip(&old.entities) {
                let mut entity = self.entities.remove(&new.id).unwrap();
                if std::mem::discriminant(&entity.geometry)
                    != std::mem::discriminant(&self.entities[&old.id].geometry)
                {
                    return Err(CoreError::new(
                        ErrorCode::InvalidState,
                        "Projection geometry type changed; recreate it explicitly",
                    ));
                }
                entity.reference = old.clone();
                match &mut entity.geometry {
                    SketchGeometry::Line { from, to } => {
                        *from = remap[from].clone();
                        *to = remap[to].clone();
                    }
                    SketchGeometry::Circle { center, .. } => {
                        *center = remap[center].clone();
                    }
                    SketchGeometry::Arc {
                        center, from, to, ..
                    } => {
                        *center = remap[center].clone();
                        *from = remap[from].clone();
                        *to = remap[to].clone();
                    }
                    SketchGeometry::Spline { points, .. } => {
                        for p in points {
                            *p = remap[p].clone();
                        }
                    }
                    _ => (),
                }
                updated.push(entity);
            }
            for entity in updated {
                self.entities.insert(entity.reference.id.clone(), entity);
            }
            references = old.entities;
        }
        for r in &references {
            self.entities.get_mut(&r.id).unwrap().projected = true;
        }
        let fixed_id = format!("{id}-fixed");
        self.fixed
            .insert(fixed_id.clone(), solver::fixed_values(self, &references)?);
        self.constraints.insert(
            fixed_id.clone(),
            SketchConstraint {
                id: fixed_id,
                kind: ConstraintKind::Fix,
                parameters: ConstraintParameters {
                    points: references
                        .iter()
                        .filter(|r| {
                            matches!(self.entities[&r.id].geometry, SketchGeometry::Point { .. })
                        })
                        .cloned()
                        .collect(),
                    curves: references
                        .iter()
                        .filter(|r| {
                            !matches!(self.entities[&r.id].geometry, SketchGeometry::Point { .. })
                        })
                        .cloned()
                        .collect(),
                },
            },
        );
        let projection = SketchProjection {
            id: id.clone(),
            source,
            entities: references,
            warning: None,
        };
        self.projections.insert(id, projection.clone());
        Ok(projection)
    }
}
