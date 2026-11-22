use crate::{
    error::{CoreError, ErrorCode, Result},
    model::Scene,
    protocol::*,
    sketch::Boundary,
};

impl Scene {
    pub(crate) fn extrude_faces_for(&self, query: &ExtrudeFaceQuery) -> Result<Vec<FaceRef>> {
        let feature = self.features.get(&query.feature).ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                "Extrusion feature does not exist in this scene",
            )
        })?;
        let Operation::Extrude {
            inputs, parameters, ..
        } = &feature.data.operation;
        let index = match (&query.profile, &inputs.profile) {
            (ProfileRef::Region(r), inputs) => inputs.regions().iter().position(|p| p == r),
            (ProfileRef::Face(f), Profiles::Face(input)) => (f == input).then_some(0),
            (ProfileRef::Face(f), Profiles::Faces(inputs)) => inputs.iter().position(|p| p == f),
            _ => None,
        }
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::InvalidParameter,
                "Profile is not an input of this extrusion",
            )
        })?;

        let double = parameters.extrusion_type() != ExtrudeType::OneSide;
        let second = matches!(
            query.selector,
            ExtrudeFaceSelector::EndCap2 | ExtrudeFaceSelector::SideFaces2 { .. }
        );
        if second && !double {
            return Err(CoreError::new(
                ErrorCode::InvalidParameter,
                "A one-sided extrusion has no side 2",
            ));
        }
        if double && matches!(query.selector, ExtrudeFaceSelector::StartCap) {
            return Ok(Vec::new());
        }
        let cap_slot = match query.selector {
            ExtrudeFaceSelector::EndCap1 => Some(0),
            ExtrudeFaceSelector::StartCap | ExtrudeFaceSelector::EndCap2 => Some(1),
            _ => None,
        };
        let edge_indices = match &query.selector {
            ExtrudeFaceSelector::SideFaces1 { edge: Some(edge) }
            | ExtrudeFaceSelector::SideFaces2 { edge: Some(edge) } => {
                let slot = match &query.profile {
                    ProfileRef::Region(region)
                        if region.scene_id == edge.scene_id
                            && region.sketch_id == edge.sketch_id =>
                    {
                        match self.sketches[&region.sketch_id].profile(region)? {
                            Boundary::Profile(profile) => Some(
                                profile
                                    .edges
                                    .iter()
                                    .enumerate()
                                    .filter_map(|(i, id)| (id == &edge.id).then_some(i))
                                    .collect::<Vec<_>>(),
                            )
                            .filter(|indices| !indices.is_empty()),
                        }
                    }
                    _ => None,
                }
                .ok_or_else(|| {
                    CoreError::new(
                        ErrorCode::InvalidParameter,
                        "Edge does not bound the selected sketch profile",
                    )
                })?;
                Some(slot)
            }
            _ => None,
        };
        let mut result = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for (body_id, groups) in &feature.faces_by_body {
            let Some((_, group)) = groups.iter().find(|(profile, _)| *profile == index) else {
                continue;
            };
            let base = group.start;
            let edges = (group.len() - 2) / if double { 2 } else { 1 };
            let side_start = base + 2 + if second { edges } else { 0 };
            let slots: Vec<usize> = match (cap_slot, &edge_indices) {
                (Some(n), _) => vec![base + n],
                (_, Some(indices)) => indices.iter().map(|n| side_start + n).collect(),
                _ => (side_start..side_start + edges).collect(),
            };
            for slot in slots {
                for (body, face_id) in self.face_descendants(body_id, slot..slot + 1)? {
                    if seen.insert((&body.reference.id, face_id)) {
                        result.push(FaceRef::Selected {
                            scene_id: self.data.id.clone(),
                            body_id: body.reference.id.clone(),
                            face_id,
                        });
                    }
                }
            }
        }
        Ok(result)
    }
}
