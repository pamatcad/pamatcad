use super::*;
pub(super) struct CachedCurve {
    key: Vec<u8>,
    points: Vec<[f64; 3]>,
}
impl Sketch {
    pub fn curve_samples(&self, id: &str, _count: usize) -> Result<Vec<[f64; 2]>> {
        if let Some(SketchEntity {
            geometry: SketchGeometry::Line { from, to },
            ..
        }) = self.entities.get(id)
        {
            return Ok(vec![self.point_position(from)?, self.point_position(to)?]);
        }
        let points = crate::kernel::sketch::curve_samples(self, id)?;
        Ok(points
            .into_iter()
            .map(|p| {
                let d = std::array::from_fn::<_, 3, _>(|i| p[i] - self.frame.origin[i]);
                [
                    d.iter().zip(self.frame.u).map(|(a, b)| a * b).sum(),
                    d.iter().zip(self.frame.v).map(|(a, b)| a * b).sum(),
                ]
            })
            .collect())
    }
    pub fn display_curves(&self) -> Result<Vec<SketchCurveProxy>> {
        let previous = self.curve_cache.borrow();
        let mut next = BTreeMap::new();
        let curves = self
            .entities
            .values()
            .filter(|e| !matches!(e.geometry, SketchGeometry::Point { .. }))
            .map(|e| {
                let key = crate::kernel::sketch::geometry_key(self, Some(&e.reference.id))?;
                let cached =
                    if let Some(cached) = previous.get(&e.reference.id).filter(|c| c.key == key) {
                        Rc::clone(cached)
                    } else {
                        let points = if let SketchGeometry::Line { from, to } = &e.geometry {
                            vec![
                                self.frame.point(self.point_position(from)?),
                                self.frame.point(self.point_position(to)?),
                            ]
                        } else {
                            crate::kernel::sketch::curve_samples(self, &e.reference.id)?
                        };
                        Rc::new(CachedCurve { key, points })
                    };
                next.insert(e.reference.id.clone(), Rc::clone(&cached));
                Ok(SketchCurveProxy {
                    entity: e.reference.clone(),
                    points: cached.points.clone(),
                    construction: e.construction,
                    projected: e.projected,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        drop(previous);
        *self.curve_cache.borrow_mut() = next;
        Ok(curves)
    }
}
