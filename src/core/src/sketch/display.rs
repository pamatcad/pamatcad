use super::*;
impl Sketch {
    pub fn curve_samples(&self, id: &str, _count: usize) -> Result<Vec<[f64; 2]>> {
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
        self.entities
            .values()
            .filter(|e| !matches!(e.geometry, SketchGeometry::Point { .. }))
            .map(|e| {
                Ok(SketchCurveProxy {
                    entity: e.reference.clone(),
                    points: crate::kernel::sketch::curve_samples(self, &e.reference.id)?,
                    construction: e.construction,
                    projected: e.projected,
                })
            })
            .collect()
    }
}
