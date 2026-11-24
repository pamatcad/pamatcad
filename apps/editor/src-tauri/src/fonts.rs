use base64::Engine as _;
use font_kit::{handle::Handle, properties::Style, source::SystemSource};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    id: String,
    family: String,
    style: String,
    weight: f32,
    italic: bool,
}

#[derive(Default)]
pub struct Fonts(Mutex<Option<(Vec<Handle>, Vec<FontInfo>)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontData {
    pub font_base64: String,
    pub font_index: u32,
}

impl Fonts {
    pub fn list(&self) -> Result<Vec<FontInfo>, String> {
        let mut catalog = self.0.lock().map_err(|e| e.to_string())?;
        if let Some((_, info)) = &*catalog {
            return Ok(info.clone());
        }
        let mut handles = vec![];
        let mut info = vec![];
        for handle in SystemSource::new().all_fonts().map_err(|e| e.to_string())? {
            if let Ok(font) = handle.load() {
                let properties = font.properties();
                info.push(FontInfo {
                    id: handles.len().to_string(),
                    family: font.family_name(),
                    style: font.full_name(),
                    weight: properties.weight.0,
                    italic: properties.style != Style::Normal,
                });
                handles.push(handle);
            }
        }
        *catalog = Some((handles, info.clone()));
        Ok(info)
    }

    pub fn load(&self, id: &str) -> Result<FontData, String> {
        let catalog = self.0.lock().map_err(|e| e.to_string())?;
        let handle = id
            .parse::<usize>()
            .ok()
            .and_then(|i| catalog.as_ref()?.0.get(i))
            .ok_or("Installed font is not in the current catalog")?;
        let (bytes, font_index) = match handle {
            Handle::Path { path, font_index } => {
                (std::fs::read(path).map_err(|e| e.to_string())?, *font_index)
            }
            Handle::Memory { bytes, font_index } => (bytes.as_ref().clone(), *font_index),
        };
        Ok(FontData {
            font_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            font_index,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_font_catalog_loads_faces_without_accepting_paths() {
        let fonts = Fonts::default();
        let catalog = fonts.list().expect("List installed system fonts");
        assert!(!catalog.is_empty());
        let selected = &catalog[0];
        assert!(!selected.family.is_empty());
        let loaded = fonts.load(&selected.id).expect("Load a catalog font");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(loaded.font_base64)
            .unwrap();
        assert!(bytes.len() > 12);
        assert!(fonts.load("/etc/passwd").is_err());
        assert!(fonts.load("999999999").is_err());
        assert_eq!(fonts.list().unwrap().len(), catalog.len());
    }
}
