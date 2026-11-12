use super::Scene;
use crate::{
    capture,
    error::{CoreError, ErrorCode, Result},
    kernel::Shape,
    protocol::{BodyRef, CaptureScene, EncodedFile},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::BTreeSet;

impl Scene {
    fn selected_shapes(&self, selection: Option<&[BodyRef]>) -> Result<Vec<&Shape>> {
        let shapes: Vec<_> = if let Some(refs) = selection {
            let mut seen = BTreeSet::new();
            let mut shapes = Vec::with_capacity(refs.len());
            for body in refs {
                if body.scene_id != self.data.id || !seen.insert(&body.id) {
                    return Err(CoreError::new(
                        ErrorCode::InvalidParameter,
                        "Select distinct bodies in this scene",
                    ));
                }
                let body = self
                    .bodies
                    .get(&body.id)
                    .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "Body does not exist"))?;
                shapes.push(&body.shape);
            }
            shapes
        } else {
            self.bodies.values().map(|b| &b.shape).collect()
        };
        if shapes.is_empty() {
            return Err(CoreError::new(
                ErrorCode::InvalidState,
                "No committed bodies to export or capture",
            ));
        }
        Ok(shapes)
    }

    pub fn export_step(&self, selection: Option<&[BodyRef]>) -> Result<EncodedFile> {
        let bytes = Shape::write_step(&self.selected_shapes(selection)?)?;
        Ok(EncodedFile {
            media_type: "model/step".into(),
            base64: STANDARD.encode(bytes),
        })
    }

    pub fn capture(&self, request: &CaptureScene) -> Result<EncodedFile> {
        let bodies = self.selected_shapes(request.bodies.as_deref())?;
        let bytes = capture::jpeg(&bodies, request)?;
        Ok(EncodedFile {
            media_type: "image/jpeg".into(),
            base64: STANDARD.encode(bytes),
        })
    }
}
