use super::*;
use crate::sketch::DragGoal;
fn invalid(message: &str) -> CoreError {
    CoreError::new(ErrorCode::InvalidParameter, message)
}
impl Engine {
    pub(super) fn validate_sketch_name(
        &self,
        scene: &str,
        id: &str,
        name: Option<&str>,
    ) -> Result<()> {
        if let Some(name) = name {
            if name.trim().is_empty()
                || self
                    .scene(scene)?
                    .sketches
                    .values()
                    .any(|s| s.data.id != id && s.data.name.as_deref() == Some(name))
            {
                return Err(invalid(
                    "Sketch name must be nonempty and unique in the scene",
                ));
            }
        }
        Ok(())
    }
    fn external_dimensions(
        &self,
        reference: &SketchRef,
    ) -> Result<BTreeMap<String, (SketchEntityRef, FormulaQuantity<FormulaUnit>)>> {
        let mut values = BTreeMap::new();
        for sketch in self.scene(&reference.scene_id)?.sketches.values() {
            if sketch.data.id == reference.id {
                continue;
            }
            for d in sketch.dimensions.values() {
                let value = (sketch.entity_ref(&d.id), d.computed.clone());
                for name in
                    std::iter::once(sketch.data.id.as_str()).chain(sketch.data.name.as_deref())
                {
                    for dimension in
                        std::iter::once(d.id.as_str()).chain(d.parameters.name.as_deref())
                    {
                        values.insert(
                            format!("sketches[{name}]dimension[{dimension}]"),
                            value.clone(),
                        );
                    }
                }
                values.insert(format!("{}{}", sketch.data.id, d.id), value);
            }
        }
        Ok(values)
    }
    pub(super) fn update_sketch<T>(
        &mut self,
        reference: &SketchRef,
        action: impl FnOnce(&mut Sketch) -> Result<T>,
    ) -> Result<T> {
        self.update_sketch_for(0, false, reference, action)
    }
    pub(super) fn view_sketch(&self, session: u64, query: &SketchViewQuery) -> Result<&Sketch> {
        if query.preview.unwrap_or(false) {
            self.sketch_previews
                .get(&(session, query.sketch.scene_id.clone()))
                .filter(|s| s.data.id == query.sketch.id)
                .ok_or_else(|| {
                    CoreError::new(ErrorCode::PreviewUnavailable, "No cached sketch preview")
                })
        } else {
            self.sketch(&query.sketch)
        }
    }
    pub(super) fn update_sketch_for<T>(
        &mut self,
        session: u64,
        preview: bool,
        reference: &SketchRef,
        action: impl FnOnce(&mut Sketch) -> Result<T>,
    ) -> Result<T> {
        self.update_sketch_checked(session, preview, reference, action, |_, _| Ok(()), &[])
    }
    fn update_sketch_checked<T>(
        &mut self,
        session: u64,
        preview: bool,
        reference: &SketchRef,
        action: impl FnOnce(&mut Sketch) -> Result<T>,
        validate: impl FnOnce(&Sketch, &T) -> Result<()>,
        drag: &[DragGoal],
    ) -> Result<T> {
        if preview {
            self.sketch_previews
                .remove(&(session, reference.scene_id.clone()));
        }
        let units = self.scene(&reference.scene_id)?.data.units;
        let external = self.external_dimensions(reference)?;
        let mut sketch = self.sketch(reference)?.clone();
        sketch.ensure_editable()?;
        let result = action(&mut sketch)?;
        if sketch.auto_recompute {
            if !drag.is_empty() {
                sketch.solve_drag(units, &external, drag)?;
            } else {
                sketch.solve(units, &external)?;
            }
        } else {
            sketch.status.state = SketchSolveState::Stale;
            sketch.validate_geometry()?;
        }
        validate(&sketch, &result)?;
        self.validate_dimension_dependencies(&sketch)?;
        sketch.revision += 1;
        if preview {
            self.sketch_previews
                .insert((session, reference.scene_id.clone()), sketch);
            return Ok(result);
        }
        self.scenes
            .get_mut(&reference.scene_id)
            .unwrap()
            .sketches
            .insert(reference.id.clone(), sketch);
        self.invalidate_previews(&reference.scene_id);
        Ok(result)
    }
    fn validate_dimension_dependencies(&self, candidate: &Sketch) -> Result<()> {
        let scene = self.scene(&candidate.data.scene_id)?;
        fn visit(
            id: &str,
            scene: &Scene,
            candidate: &Sketch,
            path: &mut Vec<String>,
            done: &mut std::collections::BTreeSet<String>,
        ) -> Result<()> {
            if path.iter().any(|p| p == id) {
                return Err(invalid("Cross-sketch dimension dependency cycle"));
            }
            if !done.insert(id.to_owned()) {
                return Ok(());
            }
            let sketch = if id == candidate.data.id {
                candidate
            } else {
                scene
                    .sketches
                    .get(id)
                    .ok_or_else(|| invalid("Referenced sketch does not exist"))?
            };
            path.push(id.to_owned());
            let dependencies = sketch
                .dimensions
                .values()
                .flat_map(|d| d.dependencies.iter())
                .chain(
                    sketch
                        .texts
                        .values()
                        .flat_map(|t| match &t.parameters.size {
                            Formula::Evaluated(e) => e.references.as_slice(),
                            _ => &[],
                        })
                        .map(|r| &r.dimension),
                );
            for r in dependencies {
                let source = if r.sketch_id == candidate.data.id {
                    candidate
                } else {
                    scene
                        .sketches
                        .get(&r.sketch_id)
                        .ok_or_else(|| invalid("Referenced sketch does not exist"))?
                };
                if !source.dimensions.contains_key(&r.id) {
                    return Err(invalid("Cannot remove a referenced dimension"));
                }
                if r.sketch_id != id {
                    visit(&r.sketch_id, scene, candidate, path, done)?;
                }
            }
            path.pop();
            Ok(())
        }
        // Evaluated formulas carry their dependencies in the shared wire representation.
        // Walk that representation so new modeling commands do not need sketch-specific hooks.
        fn check_formulas(value: &serde_json::Value, candidate: &Sketch) -> Result<()> {
            match value {
                serde_json::Value::Object(fields) => {
                    if fields.contains_key("expression")
                        && fields.contains_key("computed")
                        && fields.contains_key("dimension")
                    {
                        if let Ok(formula) =
                            serde_json::from_value::<EvaluatedFormula<FormulaUnit>>(value.clone())
                        {
                            for reference in formula.references {
                                let r = reference.dimension;
                                if r.sketch_id == candidate.data.id
                                    && !candidate.dimensions.contains_key(&r.id)
                                {
                                    return Err(invalid("Cannot remove a dimension referenced by a timeline feature"));
                                }
                            }
                        }
                    }
                    for child in fields.values() {
                        check_formulas(child, candidate)?;
                    }
                }
                serde_json::Value::Array(items) => {
                    for child in items {
                        check_formulas(child, candidate)?;
                    }
                }
                _ => (),
            }
            Ok(())
        }
        for feature in scene.features.values() {
            let value = serde_json::to_value(&feature.data.operation)
                .map_err(|_| invalid("Cannot read feature formula dependencies"))?;
            check_formulas(&value, candidate)?;
        }
        let mut done = std::collections::BTreeSet::new();
        for id in scene.sketches.keys() {
            visit(id, scene, candidate, &mut vec![], &mut done)?;
        }
        Ok(())
    }
    pub(super) fn recompute_sketch(&mut self, r: &SketchRef) -> Result<()> {
        let external = self.external_dimensions(r)?;
        let units = self.scene(&r.scene_id)?.data.units;
        let mut sketch = self.sketch(r)?.clone();
        sketch.solve(units, &external)?;
        self.validate_dimension_dependencies(&sketch)?;
        sketch.revision += 1;
        self.scenes
            .get_mut(&r.scene_id)
            .unwrap()
            .sketches
            .insert(r.id.clone(), sketch);
        self.invalidate_previews(&r.scene_id);
        Ok(())
    }
    pub(super) fn find_sketch(&self, input: SketchFind) -> Result<SketchData> {
        if input.id.is_some() == input.name.is_some() {
            return Err(invalid("Find a sketch by either ID or name"));
        }
        self.scene(&input.scene_id)?
            .sketches
            .values()
            .find(|s| {
                input.id.as_ref() == Some(&s.data.id)
                    || (input.name.is_some() && input.name == s.data.name)
            })
            .map(|s| s.data.clone())
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "Sketch not found"))
    }
    pub(super) fn edit_sketch(&mut self, input: SketchQuery) -> Result<SketchData> {
        let sketch = self.sketch(&input.sketch)?;
        if !sketch.data.completed {
            return Err(CoreError::new(
                ErrorCode::InvalidState,
                "Sketch is already being edited",
            ));
        }
        let mut working = sketch.clone();
        working.saved = Some(Box::new(sketch.clone()));
        working.data.completed = false;
        let data = working.data.clone();
        self.scenes
            .get_mut(&data.scene_id)
            .unwrap()
            .sketches
            .insert(data.id.clone(), working);
        self.invalidate_previews(&data.scene_id);
        Ok(data)
    }
    pub(super) fn cancel_sketch(&mut self, input: SketchQuery) -> Result<()> {
        self.sketch(&input.sketch)?.ensure_editable()?;
        let scene = self.scenes.get_mut(&input.sketch.scene_id).unwrap();
        let sketch = scene.sketches.remove(&input.sketch.id).unwrap();
        if let Some(saved) = sketch.saved {
            scene.sketches.insert(input.sketch.id, *saved);
        }
        self.invalidate_previews(&input.sketch.scene_id);
        Ok(())
    }
    pub(super) fn complete_sketch(&mut self, input: SketchQuery) -> Result<SketchData> {
        self.sketch(&input.sketch)?.ensure_editable()?;
        let mut sketch = self.sketch(&input.sketch)?.clone();
        sketch.solve(
            self.scene(&input.sketch.scene_id)?.data.units,
            &self.external_dimensions(&input.sketch)?,
        )?;
        self.validate_dimension_dependencies(&sketch)?;
        sketch.complete()?;
        sketch.saved = None;
        if !self
            .scene(&input.sketch.scene_id)?
            .timeline
            .iter()
            .any(|e| matches!(e,TimelineEntry::Sketch{id}if id==&sketch.data.id))
        {
            let data = sketch.data.clone();
            let scene = self.scenes.get_mut(&data.scene_id).unwrap();
            scene.timeline.push(TimelineEntry::Sketch {
                id: data.id.clone(),
            });
            scene.sketches.insert(data.id.clone(), sketch);
            self.invalidate_previews(&data.scene_id);
            return Ok(data);
        }
        self.rebuild_with_sketch(sketch)
    }

    pub(super) fn sketch_settings(&mut self, input: SketchSettings) -> Result<SketchState> {
        self.validate_sketch_name(
            &input.sketch.scene_id,
            &input.sketch.id,
            input.name.as_deref(),
        )?;
        self.update_sketch(&input.sketch, |sketch| {
            if let Some(name) = input.name {
                sketch.data.name = Some(name);
            }
            if let Some(auto) = input.auto_recompute {
                sketch.auto_recompute = auto;
            }
            Ok(())
        })?;
        Ok(self.sketch(&input.sketch)?.state())
    }
    pub(super) fn add_sketch_dimension(&mut self, input: AddDimension) -> Result<SketchDimension> {
        let units = self.scene(&input.sketch.scene_id)?.data.units;
        let before = self.sketch(&input.sketch)?.status.degrees_of_freedom;
        let id = self.update_sketch(&input.sketch, |sketch| {
            for r in input
                .parameters
                .points
                .iter()
                .chain(&input.parameters.curves)
                .chain(input.parameters.line.iter())
                .chain(input.parameters.curve.iter())
            {
                sketch.check_reference(r)?;
            }
            sketch.validate_dimension(input.kind, &input.parameters)?;
            if input.parameters.name.as_ref().is_some_and(|name| {
                name.trim().is_empty()
                    || sketch
                        .dimensions
                        .values()
                        .any(|d| d.parameters.name.as_ref() == Some(name))
            }) {
                return Err(invalid(
                    "Dimension name must be nonempty and unique in the sketch",
                ));
            }
            let id = sketch.id("dimension");
            let unit = units.unit(if input.kind == DimensionKind::Angle {
                FormulaDimension::Angle
            } else {
                FormulaDimension::Length
            });
            sketch.dimensions.insert(
                id.clone(),
                SketchDimension {
                    id: id.clone(),
                    kind: input.kind,
                    parameters: input.parameters,
                    computed: FormulaQuantity { value: 0., unit },
                    dependencies: vec![],
                },
            );
            Ok(id)
        })?;
        if self.sketch(&input.sketch)?.auto_recompute
            && self.sketch(&input.sketch)?.status.degrees_of_freedom == before
        {
            self.update_sketch(&input.sketch, |sketch| {
                let d = sketch.dimensions.get_mut(&id).unwrap();
                d.parameters.mode = DimensionMode::Driven;
                d.parameters.value = None;
                Ok(())
            })?;
        }
        Ok(self.sketch(&input.sketch)?.dimensions[&id].clone())
    }
    pub(super) fn update_sketch_dimension(
        &mut self,
        input: UpdateDimension,
    ) -> Result<SketchDimension> {
        // Annotation-only edits do not solve, change geometry revisions, or invalidate proxies.
        if let Some(annotation) = &input.annotation {
            if annotation.position.iter().any(|v| !v.is_finite()) {
                return Err(invalid("Dimension annotation coordinates must be finite"));
            }
            if input.value.is_none() && input.name.is_none() && input.mode.is_none() {
                let sketch = self
                    .scenes
                    .get_mut(&input.sketch.scene_id)
                    .and_then(|s| s.sketches.get_mut(&input.sketch.id))
                    .ok_or_else(|| invalid("Sketch does not exist"))?;
                sketch.ensure_editable()?;
                let d = sketch
                    .dimensions
                    .get_mut(&input.id)
                    .ok_or_else(|| invalid("Dimension does not exist"))?;
                d.parameters.annotation = input.annotation;
                return Ok(d.clone());
            }
        }
        self.update_sketch(&input.sketch, |sketch| {
            if input.name.as_ref().is_some_and(|name| {
                name.trim().is_empty()
                    || sketch
                        .dimensions
                        .values()
                        .any(|d| d.id != input.id && d.parameters.name.as_ref() == Some(name))
            }) {
                return Err(invalid("Dimension name must be nonempty and unique"));
            }
            let d = sketch
                .dimensions
                .get_mut(&input.id)
                .ok_or_else(|| invalid("Dimension does not exist"))?;
            if let Some(annotation) = input.annotation {
                d.parameters.annotation = Some(annotation);
            }
            if let Some(value) = input.value {
                d.parameters.value = Some(value);
                sketch.bindings.remove(&input.id);
            }
            if let Some(name) = input.name {
                d.parameters.name = Some(name);
            }
            if let Some(mode) = input.mode {
                d.parameters.mode = mode;
                if mode == DimensionMode::Driving && d.parameters.value.is_none() {
                    d.parameters.value =
                        Some(Formula::Number(d.computed.value * d.computed.unit.scale()));
                }
            }
            Ok(())
        })?;
        Ok(self.sketch(&input.sketch)?.dimensions[&input.id].clone())
    }
    pub(super) fn remove_sketch_items(
        &mut self,
        mut input: RemoveSketchItems,
    ) -> Result<SketchState> {
        self.update_sketch(&input.sketch, |sketch| {
            let mut ids = vec![];
            for id in &input.ids {
                if sketch.texts.contains_key(id) {
                    if let Some(frame) = &sketch.texts[id].frame {
                        ids.extend(frame.references().iter().map(|r| r.id.clone()));
                    }
                    let geometry = sketch.explode_text(id)?;
                    ids.extend(
                        geometry
                            .points
                            .iter()
                            .chain(&geometry.curves)
                            .map(|r| r.id.clone()),
                    );
                } else if let Some(projection) = sketch.projections.remove(id) {
                    ids.extend(projection.entities.into_iter().map(|r| r.id));
                    let fixed = format!("{id}-fixed");
                    sketch.constraints.remove(&fixed);
                    sketch.fixed.remove(&fixed);
                } else {
                    sketch.ensure_text_outline_editable(id)?;
                    sketch.ensure_text_frame_editable(id)?;
                    if sketch.entities.get(id).is_some_and(|e| e.projected)
                        || sketch
                            .projections
                            .keys()
                            .any(|p| id == &format!("{p}-fixed"))
                    {
                        return Err(invalid(
                            "Projected geometry is read-only; remove its projection",
                        ));
                    }
                    ids.push(id.clone());
                }
            }
            input.ids = ids;
            if input
                .ids
                .iter()
                .any(|id| id == "origin" || id == "origin-fixed")
            {
                return Err(invalid("Cannot remove the sketch origin"));
            }
            for id in &input.ids {
                if sketch.dimensions.values().any(|d| {
                    !input.ids.contains(&d.id)
                        && d.dependencies
                            .iter()
                            .any(|r| r.sketch_id == sketch.data.id && r.id == *id)
                }) {
                    return Err(invalid("Cannot remove a referenced dimension"));
                }
                if sketch.entities.values().any(|e| {
                    !input.ids.contains(&e.reference.id)
                        && match &e.geometry {
                            SketchGeometry::Line { from, to } => from == id || to == id,
                            SketchGeometry::Arc {
                                center, from, to, ..
                            } => center == id || from == id || to == id,
                            SketchGeometry::Circle { center, .. }
                            | SketchGeometry::Ellipse { center, .. } => center == id,
                            SketchGeometry::Spline { points, .. } => points.contains(id),
                            _ => false,
                        }
                }) {
                    return Err(invalid("Cannot remove a point still used by a curve"));
                }
                let found = sketch.entities.remove(id).is_some()
                    | sketch.dimensions.remove(id).is_some()
                    | sketch.constraints.remove(id).is_some();
                if !found {
                    return Err(invalid("Sketch item does not exist"));
                }
                sketch.fixed.remove(id);
                sketch.bindings.remove(id);
            }
            sketch.constraints.retain(|_, c| {
                !c.parameters
                    .points
                    .iter()
                    .chain(&c.parameters.curves)
                    .any(|r| input.ids.contains(&r.id))
            });
            sketch.dimensions.retain(|_, d| {
                !d.parameters
                    .points
                    .iter()
                    .chain(&d.parameters.curves)
                    .chain(d.parameters.line.iter())
                    .chain(d.parameters.curve.iter())
                    .any(|r| input.ids.contains(&r.id))
            });
            Ok(())
        })?;
        Ok(self.sketch(&input.sketch)?.state())
    }
    pub(super) fn drag_sketch_geometry(
        &mut self,
        input: DragSketchGeometry,
    ) -> Result<SketchState> {
        let (reference, entity) = match &input {
            DragSketchGeometry::Point(input) => (&input.sketch, &input.point),
            DragSketchGeometry::Line { sketch, line, .. } => (sketch, line),
            DragSketchGeometry::Circle { sketch, circle, .. } => (sketch, circle),
            DragSketchGeometry::Curve { sketch, curve, .. } => (sketch, curve),
        };
        let sketch = self.sketch(reference)?;
        sketch.check_reference(entity)?;
        sketch.ensure_text_outline_editable(&entity.id)?;
        // Frame helpers are constraint references. Only the center can be dragged,
        // moving the text as a rigid object instead of deforming its rectangle.
        if let Some(text) = sketch.text_frame_owner(&entity.id) {
            if entity.id != text.frame.as_ref().unwrap().center.id {
                return Err(invalid("Text frame geometry cannot be dragged independently; drag the text or its center"));
            }
        }
        let entity = &sketch.entities[&entity.id];
        if entity.projected {
            return Err(invalid("Projected geometry is read-only"));
        }
        let targets = match (&input, &entity.geometry) {
            (DragSketchGeometry::Point(input), SketchGeometry::Point { .. }) => {
                vec![DragGoal::Point(input.point.id.clone(), input.position)]
            }
            (
                DragSketchGeometry::Line { from, to, .. },
                SketchGeometry::Line { from: a, to: b },
            ) => {
                vec![
                    DragGoal::Point(a.clone(), *from),
                    DragGoal::Point(b.clone(), *to),
                ]
            }
            (
                DragSketchGeometry::Circle {
                    circle, position, ..
                }
                | DragSketchGeometry::Curve {
                    curve: circle,
                    position,
                    ..
                },
                SketchGeometry::Circle { .. } | SketchGeometry::Arc { .. },
            ) => vec![DragGoal::CircularEdge(circle.id.clone(), *position)],
            (DragSketchGeometry::Circle { .. } | DragSketchGeometry::Curve { .. }, _) => {
                return Err(invalid("Select a circle or arc to drag"))
            }
            (DragSketchGeometry::Point(_), _) => return Err(invalid("Select a point to drag")),
            (DragSketchGeometry::Line { .. }, _) => return Err(invalid("Select a line to drag")),
        };
        self.update_sketch_checked(
            0,
            false,
            reference,
            |sketch| {
                for goal in &targets {
                    let (id, target) = match goal {
                        DragGoal::Point(id, target) | DragGoal::CircularEdge(id, target) => {
                            (id, target)
                        }
                    };
                    if !target.iter().all(|v| v.is_finite()) {
                        return Err(invalid("Drag coordinates must be finite"));
                    }
                    if !sketch.auto_recompute {
                        if let Some(text) = sketch.text_frame_owner(id).cloned() {
                            let old = sketch.point_position(id)?;
                            let mut parameters = text.parameters;
                            for i in 0..2 {
                                parameters.origin[i] += target[i] - old[i];
                            }
                            sketch.update_text(&text.id, parameters)?;
                            continue;
                        }
                        let radius = match &sketch.entities[id].geometry {
                            SketchGeometry::Circle { center, .. }
                            | SketchGeometry::Arc { center, .. } => {
                                let c = sketch.point_position(center)?;
                                Some((target[0] - c[0]).hypot(target[1] - c[1]))
                            }
                            _ => None,
                        };
                        match &mut sketch.entities.get_mut(id).unwrap().geometry {
                            SketchGeometry::Point { position } => *position = *target,
                            SketchGeometry::Circle { radius: r, .. }
                            | SketchGeometry::Arc { radius: r, .. } => *r = radius.unwrap(),
                            _ => (),
                        }
                        // Manual radius/center edits keep the arc's endpoint representation coherent.
                        let arcs: Vec<_> = sketch
                            .entities
                            .values()
                            .filter_map(|entity| {
                                if let SketchGeometry::Arc {
                                    center,
                                    from,
                                    to,
                                    radius,
                                    start,
                                    end,
                                } = &entity.geometry
                                {
                                    if &entity.reference.id == id || center == id {
                                        return Some((
                                            center.clone(),
                                            from.clone(),
                                            to.clone(),
                                            *radius,
                                            *start,
                                            *end,
                                        ));
                                    }
                                }
                                None
                            })
                            .collect();
                        for (center, from, to, radius, start, end) in arcs {
                            let c = sketch.point_position(&center)?;
                            for (point, angle) in [(from, start), (to, end)] {
                                if let SketchGeometry::Point { position } =
                                    &mut sketch.entities.get_mut(&point).unwrap().geometry
                                {
                                    *position =
                                        [c[0] + radius * angle.cos(), c[1] + radius * angle.sin()];
                                }
                            }
                        }
                    }
                }
                Ok(())
            },
            |_, _| Ok(()),
            &targets,
        )?;
        Ok(self.sketch(reference)?.state())
    }
}

impl Engine {
    fn rebuild_with_sketch(&mut self, candidate: Sketch) -> Result<SketchData> {
        use super::modeling::ModelingCommand;
        let scene_id = candidate.data.scene_id.clone();
        let original = self.scene(&scene_id)?;
        let mut timeline = original.timeline.clone();
        if !timeline
            .iter()
            .any(|e| matches!(e,TimelineEntry::Sketch{id}if id==&candidate.data.id))
        {
            timeline.push(TimelineEntry::Sketch {
                id: candidate.data.id.clone(),
            });
        }
        let features = original
            .features
            .iter()
            .map(|(id, f)| (id.clone(), f.data.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut scene = Scene::new(
            scene_id.clone(),
            original.data.name.clone(),
            original.data.units,
        );
        scene.sketches = original.sketches.clone();
        scene
            .sketches
            .insert(candidate.data.id.clone(), candidate.clone());
        let mut rebuilt = Engine {
            next_id: self.next_id,
            next_revision: self.next_revision,
            ..Engine::default()
        };
        rebuilt.scenes.insert(scene_id.clone(), scene);
        fn solve_dependencies(
            engine: &mut Engine,
            scene: &str,
            id: &str,
            visited: &mut std::collections::BTreeSet<String>,
        ) -> Result<()> {
            if !visited.insert(id.to_owned()) {
                return Ok(());
            }
            let dependencies = engine.scene(scene)?.sketches[id]
                .dimensions
                .values()
                .flat_map(|d| {
                    d.dependencies
                        .iter()
                        .filter(|r| r.sketch_id != id)
                        .map(|r| r.sketch_id.clone())
                })
                .collect::<Vec<_>>();
            let text_dependencies = engine.scene(scene)?.sketches[id]
                .texts
                .values()
                .flat_map(|t| match &t.parameters.size {
                    Formula::Evaluated(e) => e.references.as_slice(),
                    _ => &[],
                })
                .filter(|r| r.dimension.sketch_id != id)
                .map(|r| r.dimension.sketch_id.clone())
                .collect::<Vec<_>>();
            for dependency in dependencies.into_iter().chain(text_dependencies) {
                solve_dependencies(engine, scene, &dependency, visited)?;
            }
            engine.recompute_sketch(&SketchRef {
                scene_id: scene.to_owned(),
                id: id.to_owned(),
            })
        }
        let mut visited = std::collections::BTreeSet::new();
        let ids = rebuilt
            .scene(&scene_id)?
            .sketches
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            solve_dependencies(&mut rebuilt, &scene_id, &id, &mut visited)?;
        }
        for entry in timeline {
            match entry {
                TimelineEntry::Sketch { id } => {
                    let support = rebuilt.scene(&scene_id)?.sketches[&id].data.plane.clone();
                    let frame = match support {
                        SketchSupport::Plane(p) => Ok(Frame::builtin(p.plane)),
                        SketchSupport::Face(f) => rebuilt.face_frame(&f),
                    };
                    let sketch = rebuilt
                        .scenes
                        .get_mut(&scene_id)
                        .unwrap()
                        .sketches
                        .get_mut(&id)
                        .unwrap();
                    match frame {
                        Ok(frame) => {
                            sketch.frame = frame;
                            sketch
                                .status
                                .warnings
                                .retain(|w| !w.starts_with("Sketch support"));
                        }
                        Err(_) => {
                            let warning =
                                "Sketch support is unavailable; using the cached plane".to_owned();
                            if !sketch.status.warnings.contains(&warning) {
                                sketch.status.warnings.push(warning);
                            }
                        }
                    }
                    rebuilt.refresh_projections(&SketchRef {
                        scene_id: scene_id.clone(),
                        id: id.clone(),
                    })?;
                    let sketch = rebuilt
                        .scenes
                        .get_mut(&scene_id)
                        .unwrap()
                        .sketches
                        .get_mut(&id)
                        .unwrap();
                    sketch.data.completed = false;
                    sketch.complete()?;
                    rebuilt
                        .scenes
                        .get_mut(&scene_id)
                        .unwrap()
                        .timeline
                        .push(TimelineEntry::Sketch { id });
                }
                TimelineEntry::Extrude { id } => {
                    let previous = &features[&id];
                    let changes = previous
                        .operation
                        .clone()
                        .evaluate(rebuilt.scene(&scene_id)?)?;
                    rebuilt.next_revision += 1;
                    rebuilt.commit_recomputed(scene_id.clone(), changes, Some(previous));
                }
            }
        }
        let result = rebuilt.scene(&scene_id)?.sketches[&candidate.data.id]
            .data
            .clone();
        self.next_id = rebuilt.next_id;
        self.next_revision = rebuilt.next_revision;
        self.scenes
            .insert(scene_id.clone(), rebuilt.scenes.remove(&scene_id).unwrap());
        self.invalidate_previews(&scene_id);
        Ok(result)
    }
}

impl super::modeling::ModelingCommand for Operation {
    fn scene_id(&self) -> Result<&str> {
        match self {
            Operation::Extrude { inputs, .. } => match &inputs.profile {
                Profiles::Face(f) => Ok(f.scene_id()),
                Profiles::Faces(f) => f
                    .first()
                    .map(|f| f.scene_id())
                    .ok_or_else(|| invalid("Missing profile")),
                p => p
                    .regions()
                    .first()
                    .map(|r| r.scene_id.as_str())
                    .ok_or_else(|| invalid("Missing profile")),
            },
        }
    }
    fn evaluate(self, scene: &Scene) -> Result<super::modeling::ProposedChanges> {
        match self {
            Operation::Extrude {
                inputs, parameters, ..
            } => Extrude {
                profile: inputs.profile,
                targets: inputs.targets,
                parameters,
            }
            .evaluate(scene),
        }
    }
}
impl Engine {
    fn projected_curves(
        &self,
        r: &SketchRef,
        source: &ProjectionSource,
    ) -> Result<Vec<(i32, Vec<f64>)>> {
        let scene = self.scene(&r.scene_id)?;
        let frame = self.sketch(r)?.frame;
        let (body, kind, index) = match source {
            ProjectionSource::Face(face) => {
                let (body, slot) = scene.resolve_face(face)?;
                (body, 0, slot)
            }
            ProjectionSource::Edge(edge) => {
                if edge.scene_id != r.scene_id {
                    return Err(invalid("Projection source belongs to another scene"));
                }
                let body = scene
                    .bodies
                    .get(&edge.body_id)
                    .filter(|b| b.revision.to_string() == edge.revision)
                    .ok_or_else(|| invalid("Projection edge revision is unavailable"))?;
                (body, 1, edge.edge_id)
            }
            ProjectionSource::Vertex(vertex) => {
                if vertex.scene_id != r.scene_id {
                    return Err(invalid("Projection source belongs to another scene"));
                }
                let body = scene
                    .bodies
                    .get(&vertex.body_id)
                    .filter(|b| b.revision.to_string() == vertex.revision)
                    .ok_or_else(|| invalid("Projection vertex revision is unavailable"))?;
                (body, 2, vertex.vertex_id)
            }
        };
        crate::kernel::sketch::project(&body.shape, kind, index, frame)
    }
    pub(super) fn project_geometry(&mut self, input: ProjectGeometry) -> Result<SketchProjection> {
        let curves = self.projected_curves(&input.sketch, &input.source)?;
        self.update_sketch(&input.sketch, |sketch| {
            sketch.set_projection(input.id, input.source, curves)
        })
    }
    pub(super) fn update_sketch_support(
        &mut self,
        input: UpdateSketchSupport,
    ) -> Result<SketchState> {
        if input.plane.scene_id() != input.sketch.scene_id {
            return Err(invalid("Sketch support belongs to another scene"));
        }
        let frame = match &input.plane {
            SketchSupport::Plane(p) => {
                if !self.scene(&p.scene_id)?.has_plane(p) {
                    return Err(invalid("Construction plane does not exist"));
                }
                Frame::builtin(p.plane)
            }
            SketchSupport::Face(f) => self.face_frame(f)?,
        };
        let previous = self.sketch(&input.sketch)?.clone();
        self.update_sketch(&input.sketch, |s| {
            s.data.plane = input.plane;
            s.frame = frame;
            s.status
                .warnings
                .retain(|w| !w.starts_with("Sketch support"));
            Ok(())
        })?;
        if let Err(error) = self.refresh_projections(&input.sketch) {
            self.scenes
                .get_mut(&input.sketch.scene_id)
                .unwrap()
                .sketches
                .insert(input.sketch.id.clone(), previous);
            return Err(error);
        }
        Ok(self.sketch(&input.sketch)?.state())
    }
    fn refresh_projections(&mut self, r: &SketchRef) -> Result<()> {
        let projections = self
            .sketch(r)?
            .projections
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for projection in projections {
            let curves = self.projected_curves(r, &projection.source);
            let mut sketch = self.sketch(r)?.clone();
            let completed = sketch.data.completed;
            sketch.data.completed = false;
            let updated = curves.and_then(|curves| {
                sketch.set_projection(
                    Some(projection.id.clone()),
                    projection.source.clone(),
                    curves,
                )
            });
            if let Err(error) = updated {
                sketch = self.sketch(r)?.clone();
                sketch.projections.get_mut(&projection.id).unwrap().warning =
                    Some(format!("Using cached projection: {}", error.message));
            }
            sketch.data.completed = completed;
            self.scenes
                .get_mut(&r.scene_id)
                .unwrap()
                .sketches
                .insert(r.id.clone(), sketch);
        }
        self.recompute_sketch(r)
    }
}
impl Engine {
    pub(super) fn transform_sketch(
        &mut self,
        session: u64,
        input: TransformSketchGeometry,
    ) -> Result<Vec<SketchEntityRef>> {
        let scene = self.scene(&input.sketch.scene_id)?;
        let angle = input
            .angle
            .as_ref()
            .map(|f| {
                scene.evaluate_formula(f, scene.data.units.angle).map(|e| {
                    (e.computed.value * FormulaUnit::Angle(e.computed.unit).scale()).to_radians()
                })
            })
            .transpose()?
            .unwrap_or(0.);
        let scale = input
            .scale
            .as_ref()
            .map(|f| {
                scene
                    .evaluate_formula(f, FormulaUnit::Scalar(ScalarUnit::Scalar))
                    .map(|e| e.computed.value)
            })
            .transpose()?
            .unwrap_or(1.);
        self.update_sketch_checked(
            session,
            input.preview.unwrap_or(false),
            &input.sketch.clone(),
            |s| {
                let refs = s.transform(input, angle, scale)?;
                Ok((refs, s.clone()))
            },
            |s, (refs, requested)| s.validate_transform(requested, refs),
            &[],
        )
        .map(|(refs, _)| refs)
    }
}
impl Engine {
    pub(super) fn modify_sketch_curves(
        &mut self,
        session: u64,
        input: ModifySketchCurves,
    ) -> Result<SketchEditResult> {
        let scene = self.scene(&input.sketch.scene_id)?;
        let length = |f: &Formula<LengthUnit>| {
            scene
                .evaluate_formula(f, scene.data.units.length)
                .map(|e| e.computed.value * FormulaUnit::Length(e.computed.unit).scale())
        };
        let (operation, values) = match &input.operation {
            SketchCurveEdit::Split => (0, vec![0.]),
            SketchCurveEdit::Offset {
                distance1,
                distance2,
            } => {
                let mut values = vec![length(distance1)?];
                if let Some(d) = distance2 {
                    values.push(-length(d)?);
                }
                if values.iter().any(|v| v.abs() < 1e-7) {
                    return Err(invalid("Offset distances must be nonzero"));
                }
                (1, values)
            }
            SketchCurveEdit::Rounding { radius } => {
                let radius = length(radius)?;
                if radius <= 0. {
                    return Err(invalid("Rounding radius must be positive"));
                }
                (2, vec![radius])
            }
        };
        self.update_sketch_for(
            session,
            input.preview.unwrap_or(false),
            &input.sketch,
            |s| s.modify_curves(&input.curves, operation, &values),
        )
    }
}
