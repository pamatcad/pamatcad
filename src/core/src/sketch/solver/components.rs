use super::*;
use std::collections::BTreeSet;
use std::rc::Rc;

// Only the latest accepted component results are retained. Sketch transactions
// share immutable entries; replacements and failed previews cannot mutate them.
#[derive(Clone, Default)]
pub(crate) struct Cache(BTreeMap<Option<(String, usize)>, Rc<CachedComponent>>);

struct CachedComponent {
    values: Vec<f64>,
    fixed: Vec<u8>,
    geometry_count: usize,
    code: Vec<Instruction>,
    equations: Vec<Equation>,
    groups: Vec<VariableGroup>,
    group_indices: Vec<usize>,
    dof: i32,
    group_dof: Vec<i32>,
}

pub(super) struct Statistics {
    pub count: usize,
    pub largest: usize,
    pub reused: usize,
    pub partition_ms: Option<f64>,
}

#[derive(Default)]
struct Component {
    variables: BTreeSet<usize>,
    equations: Vec<usize>,
    drag: Vec<usize>,
    groups: BTreeMap<usize, Vec<usize>>,
}

fn root(parent: &mut [usize], mut index: usize) -> usize {
    while parent[index] != index {
        parent[index] = parent[parent[index]];
        index = parent[index];
    }
    index
}

// Partition the compiled equations, including intrinsic geometry and formula
// dependencies. Fixed coordinates are constants: sharing one does not couple
// otherwise independent unknowns. Reuse requires identical equations, values,
// fixed masks and freedom groups; a matching revision alone is never sufficient.
pub(super) fn solve(
    values: &mut [f64],
    geometry_count: usize,
    fixed: &[u8],
    preferred: &[u8],
    instructions: &[Instruction],
    equations: &[Equation],
    permanent_count: usize,
    drag: &[DragTarget],
    group_indices: &[usize],
    groups: &[VariableGroup],
    group_dof: &mut [i32],
    variable_ids: &[(String, usize)],
    cache: &Cache,
    mut profile: Option<&mut SolveProfile>,
) -> Result<(i32, Cache, Statistics)> {
    let started = profile.as_ref().map(|_| std::time::Instant::now());
    let mut parent: Vec<_> = (0..values.len()).collect();
    let references: Vec<Vec<usize>> = equations
        .iter()
        .map(|e| {
            instructions[e.start..e.start + e.count]
                .iter()
                .filter(|i| i.op == 1)
                .map(|i| i.index as usize)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .collect();
    // Keep both coordinates of a cursor target in one call to the existing
    // adapter. Fixed coordinates are copied into that component when needed.
    for refs in references.iter().map(|r| r.as_slice()).chain(
        drag.iter()
            .map(|d| [d.x, d.y])
            .collect::<Vec<_>>()
            .iter()
            .map(|r| r.as_slice()),
    ) {
        let mut unknowns = refs.iter().copied().filter(|&i| fixed[i] == 0);
        if let Some(first) = unknowns.next() {
            for next in unknowns {
                let a = root(&mut parent, first);
                let b = root(&mut parent, next);
                // Deterministic component ordering, independent of pointer addresses.
                parent[a.max(b)] = a.min(b);
            }
        }
    }
    let owners: Vec<_> = (0..values.len())
        .map(|i| {
            if fixed[i] == 0 {
                root(&mut parent, i)
            } else {
                usize::MAX
            }
        })
        .collect();
    let mut components: BTreeMap<usize, Component> = BTreeMap::new();
    for (i, &owner) in owners
        .iter()
        .enumerate()
        .filter(|(_, owner)| **owner != usize::MAX)
    {
        components.entry(owner).or_default().variables.insert(i);
    }
    for (index, refs) in references.iter().enumerate() {
        // Constant-only equations must still be checked for conflicts.
        let owner = refs.iter().map(|&i| owners[i]).min().unwrap_or(usize::MAX);
        let component = components.entry(owner).or_default();
        component.variables.extend(refs);
        component.equations.push(index);
    }
    for (index, target) in drag.iter().enumerate() {
        let component = components
            .entry(owners[target.x].min(owners[target.y]))
            .or_default();
        component.variables.extend([target.x, target.y]);
        component.drag.push(index);
    }
    for (index, group) in groups.iter().enumerate() {
        for &variable in &group_indices[group.start..group.start + group.count] {
            if fixed[variable] == 0 {
                components
                    .get_mut(&owners[variable])
                    .unwrap()
                    .groups
                    .entry(index)
                    .or_default()
                    .push(variable);
            }
        }
    }
    let partition_ms = started.map(|s| s.elapsed().as_secs_f64() * 1000.);
    let component_count = components.len();
    let largest_component = components
        .values()
        .map(|c| c.variables.iter().filter(|&&i| fixed[i] == 0).count())
        .max()
        .unwrap_or(0);
    let mut local_index = vec![0; values.len()];
    let mut total_dof = 0;
    let mut next_cache = Cache::default();
    let mut reused = 0;
    for (&owner, component) in &components {
        let prepare = profile.as_ref().map(|_| std::time::Instant::now());
        // Original indices put geometry before auxiliary cursor variables.
        let indices: Vec<_> = component.variables.iter().copied().collect();
        for (local, &global) in indices.iter().enumerate() {
            local_index[global] = local;
        }
        let mut local_values: Vec<_> = indices.iter().map(|&i| values[i]).collect();
        let local_fixed: Vec<_> = indices.iter().map(|&i| fixed[i]).collect();
        let local_preferred: Vec<_> = indices.iter().map(|&i| preferred[i]).collect();
        let local_geometry_count = indices.iter().take_while(|&&i| i < geometry_count).count();
        let mut code = vec![];
        let mut relations = vec![];
        for &index in &component.equations {
            let equation = &equations[index];
            let start = code.len();
            code.extend(
                instructions[equation.start..equation.start + equation.count]
                    .iter()
                    .map(|i| {
                        let mut i = *i;
                        if i.op == 1 {
                            i.index = local_index[i.index as usize] as u32;
                        }
                        i
                    }),
            );
            relations.push(Equation {
                start,
                count: equation.count,
                tag: equation.tag,
            });
        }
        let targets: Vec<_> = component
            .drag
            .iter()
            .map(|&i| DragTarget {
                x: local_index[drag[i].x],
                y: local_index[drag[i].y],
                position: drag[i].position,
            })
            .collect();
        let mut local_group_indices = vec![];
        let local_groups: Vec<_> = component
            .groups
            .values()
            .map(|variables| {
                let start = local_group_indices.len();
                local_group_indices.extend(variables.iter().map(|&i| local_index[i]));
                VariableGroup {
                    start,
                    count: variables.len(),
                }
            })
            .collect();
        let key = variable_ids.get(owner).cloned();
        // Auxiliary cursor variables/equations are temporary and cannot seed
        // permanent cache entries. A targeted component always solves again.
        let cacheable = local_geometry_count == local_values.len()
            && component.equations.iter().all(|&i| i < permanent_count);
        let cached = cache.0.get(&key).filter(|saved| {
            cacheable
                && component.drag.is_empty()
                && saved.geometry_count == local_geometry_count
                && saved.fixed == local_fixed
                && saved.equations == relations
                && saved.groups == local_groups
                && saved.group_indices == local_group_indices
                && saved.values.len() == local_values.len()
                && saved
                    .values
                    .iter()
                    .zip(&local_values)
                    .all(|(a, b)| a.to_bits() == b.to_bits())
                && saved.code.len() == code.len()
                && saved.code.iter().zip(&code).all(|(a, b)| {
                    a.op == b.op && a.index == b.index && a.value.to_bits() == b.value.to_bits()
                })
        });
        if let Some(saved) = cached {
            total_dof += saved.dof;
            for (&group, &freedom) in component.groups.keys().zip(&saved.group_dof) {
                group_dof[group] += freedom;
            }
            next_cache.0.insert(key, Rc::clone(saved));
            reused += 1;
            if let Some(p) = profile.as_deref_mut() {
                p.prepare_ms += prepare.unwrap().elapsed().as_secs_f64() * 1000.;
            }
            continue;
        }
        let mut local_group_dof = vec![0; local_groups.len()];
        let mut movable = vec![0; indices.len()];
        let mut diagnostics = vec![0; relations.len()];
        let mut diagnostic_count = diagnostics.len();
        let mut error = [0u8; 1024];
        let mut dof = 0;
        if let Some(p) = profile.as_deref_mut() {
            p.prepare_ms += prepare.unwrap().elapsed().as_secs_f64() * 1000.;
        }
        let result = unsafe {
            pamat_sketch_solve(
                local_values.as_mut_ptr(),
                local_values.len(),
                local_geometry_count,
                local_fixed.as_ptr(),
                local_preferred.as_ptr(),
                code.as_ptr(),
                relations.as_ptr(),
                relations.len(),
                component
                    .equations
                    .iter()
                    .take_while(|&&i| i < permanent_count)
                    .count(),
                targets.as_ptr(),
                targets.len(),
                !drag.is_empty(),
                &mut dof,
                movable.as_mut_ptr(),
                local_group_indices.as_ptr(),
                local_groups.as_ptr(),
                local_groups.len(),
                local_group_dof.as_mut_ptr(),
                diagnostics.as_mut_ptr(),
                &mut diagnostic_count,
                error.as_mut_ptr().cast(),
                error.len(),
                profile
                    .as_deref_mut()
                    .map_or(std::ptr::null_mut(), |p| p as *mut _),
            )
        };
        if result != 0 {
            return Err(invalid(
                String::from_utf8_lossy(
                    &error[..error.iter().position(|b| *b == 0).unwrap_or(error.len())],
                )
                .to_string(),
            ));
        }
        total_dof += dof;
        // Restricted nullspaces of independent components have disjoint rows
        // and columns; their ranks add even when an entity spans components.
        for (&group, freedom) in component.groups.keys().zip(&local_group_dof) {
            group_dof[group] += freedom;
        }
        for (&global, &value) in indices.iter().zip(&local_values) {
            values[global] = value;
        }
        if cacheable {
            next_cache.0.insert(
                key,
                Rc::new(CachedComponent {
                    values: local_values,
                    fixed: local_fixed,
                    geometry_count: local_geometry_count,
                    code,
                    equations: relations,
                    groups: local_groups,
                    group_indices: local_group_indices,
                    dof,
                    group_dof: local_group_dof,
                }),
            );
        }
    }
    Ok((
        total_dof,
        next_cache,
        Statistics {
            count: component_count,
            largest: largest_component,
            reused,
            partition_ms,
        },
    ))
}
