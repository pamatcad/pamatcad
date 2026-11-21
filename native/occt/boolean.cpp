#include "bridge_internal.hxx"
#include <BOPAlgo_CellsBuilder.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <BRepTools_History.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>

namespace {
struct CellGroup {
    std::vector<size_t> targets, tools;
    std::set<int> result_cells;
};

struct InputCells {
    const PamatShape* shape;
    std::set<int> cells;
};
}

struct PamatPartition {
    BOPAlgo_CellsBuilder builder;
    std::vector<InputCells> inputs; // Targets followed by tools.
    size_t target_count;
    int mode;
    std::vector<CellGroup> groups;

    PamatPartition(const PamatShape* const* targets, size_t nt, const PamatShape* const* tools,
                   size_t np, int requested) : target_count(nt), mode(requested) {
        NCollection_List<TopoDS_Shape> arguments;
        for (size_t i = 0; i < nt + np; ++i) {
            const auto* shape = i < nt ? targets[i] : tools[i - nt];
            inputs.push_back({shape, {}});
            arguments.Append(shape->value);
        }
        builder.SetArguments(arguments);
        builder.SetNonDestructive(true);
        builder.SetToFillHistory(true);
        builder.Perform();
        if (builder.HasErrors()) throw std::runtime_error("Could not partition the Boolean inputs");

        TopTools_IndexedMapOfShape cells;
        TopExp::MapShapes(builder.GetAllParts(), TopAbs_SOLID, cells);
        for (auto& input : inputs) {
            // Images holds the solid cells of a split input. An unsplit input is its own cell.
            const auto add = [&](const TopoDS_Shape& cell) {
                const int index = cells.FindIndex(cell);
                if (!index) throw std::runtime_error("Boolean input has no matching solid cell");
                input.cells.insert(index);
            };
            if (const auto* images = builder.Images().Seek(input.shape->value)) {
                for (const auto& cell : *images) add(cell);
            } else {
                add(input.shape->value);
            }
            if (input.cells.empty()) throw std::runtime_error("Boolean input contains no solid cells");
        }
        if (mode == PAMAT_AUTO) {
            mode = PAMAT_CUT;
            group_cuts();
            if (groups.empty()) {
                mode = PAMAT_JOIN;
                group_joins(cells);
                if (std::none_of(groups.begin(), groups.end(), [](const auto& g) { return !g.targets.empty(); })) {
                    mode = PAMAT_NEW_BODY;
                    groups.clear();
                }
            }
        } else if (mode == PAMAT_JOIN) group_joins(cells);
        else group_cuts();
    }

    void group_cuts() {
        for (size_t t = 0; t < target_count; ++t) {
            CellGroup group{{t}, {}, mode == PAMAT_INTERSECT ? std::set<int>{} : inputs[t].cells};
            for (size_t i = target_count; i < inputs.size(); ++i) {
                bool intersects = false;
                for (int cell : inputs[i].cells) {
                    if (inputs[t].cells.count(cell)) {
                        if (mode == PAMAT_INTERSECT) group.result_cells.insert(cell);
                        else group.result_cells.erase(cell);
                        intersects = true;
                    }
                }
                if (intersects) group.tools.push_back(i - target_count);
            }
            if (!group.tools.empty()) groups.push_back(std::move(group));
        }
    }

    void group_joins(const TopTools_IndexedMapOfShape& cells) {
        // A tool participates through shared material or a shared face. Pre-existing
        // contact between two targets alone must not merge unrelated scene bodies.
        TopTools_IndexedMapOfShape faces;
        std::map<int, std::vector<size_t>> owners;
        for (size_t i = 0; i < inputs.size(); ++i) {
            for (int cell : inputs[i].cells) {
                for (TopExp_Explorer face(cells.FindKey(cell), TopAbs_FACE); face.More(); face.Next()) {
                    auto& list = owners[faces.Add(face.Current())];
                    if (list.empty() || list.back() != i) list.push_back(i);
                }
            }
        }
        std::vector<size_t> parent(inputs.size());
        for (size_t i = 0; i < inputs.size(); ++i) parent[i] = i;
        auto root = [&](size_t i) {
            while (parent[i] != i) {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            return i;
        };
        for (const auto& entry : owners) {
            const auto& list = entry.second;
            if (list.back() < target_count) continue;
            const size_t group = root(list.front());
            for (auto i : list) parent[root(i)] = group;
        }
        std::map<size_t, CellGroup> connected;
        for (size_t i = 0; i < inputs.size(); ++i) {
            auto& group = connected[root(i)];
            if (i < target_count) group.targets.push_back(i);
            else group.tools.push_back(i - target_count);
            group.result_cells.insert(inputs[i].cells.begin(), inputs[i].cells.end());
        }
        for (auto& entry : connected) {
            if (!entry.second.tools.empty()) groups.push_back(std::move(entry.second));
        }
    }
};

extern "C" int pamat_partition(const PamatShape* const* targets, size_t nt, const PamatShape* const* tools,
                               size_t np, int mode, PamatPartition** output, size_t* count, int* resolved_mode,
                               char* error, size_t error_size) {
    *output = nullptr;
    return checked([&] {
        auto partition = std::make_unique<PamatPartition>(targets, nt, tools, np, mode);
        *count = partition->groups.size();
        *resolved_mode = partition->mode;
        *output = partition.release();
    }, error, error_size);
}

extern "C" PamatCellGroup pamat_partition_group(const PamatPartition* partition, size_t index) {
    const auto& g = partition->groups[index];
    return {g.targets.data(), g.targets.size(), g.tools.data(), g.tools.size()};
}

static void append_faces(PamatShape& result, const PamatShape& input,
                         BOPAlgo_CellsBuilder& builder, const occ::handle<BRepTools_History>& unified,
                         const TopTools_IndexedMapOfShape& faces) {
    for (size_t id = 0; id < input.named_faces.size(); ++id) {
        const auto& slot = input.named_faces[id];
        if (input.historical_slots.count(id)) result.historical_slots.insert(result.named_faces.size());
        auto& output = result.named_faces.emplace_back();
        auto keep = [&](const TopoDS_Shape& face) {
            const int index = faces.FindIndex(face);
            if (index) output.Add(faces.FindKey(index));
        };
        auto follow = [&](const TopoDS_Shape& face) {
            if (!unified.IsNull()) {
                for (const auto& descendant : unified->Modified(face)) keep(descendant);
            }
            keep(face);
        };
        for (const auto& face : slot) {
            follow(face);
            for (const auto& descendant : builder.Modified(face)) follow(descendant);
        }
    }
}

extern "C" int pamat_partition_result(PamatPartition* p, size_t index, size_t survivor,
                                      void (*sink)(void*, PamatShape*), void* context,
                                      int* changed, char* error, size_t error_size) {
    return checked([&] {
        const auto& g = p->groups.at(index);
        *changed = g.result_cells != p->inputs.at(survivor).cells;
        if (g.result_cells.empty() || (!*changed && g.targets.size() == 1)) return;
 
        NCollection_List<TopoDS_Shape> avoid;
        if (p->mode == PAMAT_CUT) {
            for (auto i : g.tools) avoid.Append(p->inputs[p->target_count + i].shape->value);
        }
        auto& builder = p->builder;
        builder.RemoveAllFromResult();
        auto add = [&](size_t i) {
            NCollection_List<TopoDS_Shape> take;
            take.Append(p->inputs[i].shape->value);
            builder.AddToResult(take, avoid, 1);
        };
        if (p->mode == PAMAT_INTERSECT) {
            for (auto target : g.targets) for (auto tool : g.tools) {
                NCollection_List<TopoDS_Shape> take;
                take.Append(p->inputs[target].shape->value);
                take.Append(p->inputs[p->target_count + tool].shape->value);
                builder.AddToResult(take, avoid, 1);
            }
        } else for (auto i : g.targets) add(i);
        if (p->mode == PAMAT_JOIN) {
            for (auto i : g.tools) add(p->target_count + i);
        }
        builder.RemoveInternalBoundaries();
        if (builder.HasErrors()) throw std::runtime_error("Boolean result assembly failed");
        TopExp_Explorer solids(builder.Shape(), TopAbs_SOLID);
        if (!solids.More()) throw std::runtime_error("Expected a surviving Boolean solid");
        std::vector<std::unique_ptr<PamatShape>> results;
        std::vector<double> volumes;
        for (; solids.More(); solids.Next()) {
            auto result = std::make_unique<PamatShape>();
            result->value = solids.Current();
            ShapeUpgrade_UnifySameDomain simplify(result->value, true, true, true);
            simplify.SetLinearTolerance(builder.FuzzyValue());
            simplify.SetAngularTolerance(Precision::Angular());
            simplify.SetSafeInputMode(true);
            simplify.AllowInternalEdges(false);
            simplify.Build();
            result->value = simplify.Shape();
            volumes.push_back(validated_volume(result->value));
            TopTools_IndexedMapOfShape faces;
            TopExp::MapShapes(result->value, TopAbs_FACE, faces);
            auto append = [&](size_t i) {
                append_faces(*result, *p->inputs[i].shape, builder, simplify.History(), faces);
            };
            append(survivor);
            for (auto i : g.targets) if (i != survivor) append(i);
            for (auto i : g.tools) append(p->target_count + i);
            results.push_back(std::move(result));
        }
        if (results.size() == 1) {
            results.front()->index_faces();
            sink(context, results.front().release());
            return;
        }
        if (p->mode == PAMAT_JOIN) throw std::runtime_error("Join did not form one solid");
        // Ignore integration roundoff when equal-volume fragments need a geometric tie-break.
        const double quantum = std::max(1e-9, *std::max_element(volumes.begin(), volumes.end()) * 1e-12);
        std::vector<std::pair<std::array<double, 10>, size_t>> order;
        for (size_t i = 0; i < results.size(); ++i) {
            auto& result = *results[i];
            for (size_t slot = 0; slot < result.named_faces.size(); ++slot)
                result.historical_slots.insert(slot);
            result.index_faces();
            GProp_GProps props;
            BRepGProp::VolumeProperties(result.value, props);
            const auto center = props.CentreOfMass();
            Bnd_Box bounds;
            BRepBndLib::AddOptimal(result.value, bounds, false, false);
            std::array<double, 10> key{-std::round(volumes[i] / quantum), center.X(), center.Y(), center.Z()};
            bounds.Get(key[4], key[5], key[6], key[7], key[8], key[9]);
            order.emplace_back(key, i);
        }
        std::sort(order.begin(), order.end());
        for (const auto& entry : order) sink(context, results[entry.second].release());
    }, error, error_size);
}

extern "C" void pamat_partition_free(PamatPartition* partition) { delete partition; }
