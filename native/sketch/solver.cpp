#include "solver.h"
#include <GCS.h>
#include <Eigen/SVD>
#include <algorithm>
#include <cmath>
#include <chrono>
#include <cstdio>
#include <stdexcept>
#include <vector>

namespace {
struct Dual { double value, derivative; };
class Expression final : public GCS::Constraint {
    std::vector<PamatInstruction> code;
    Dual evaluate(double* derivative) const {
        std::vector<Dual> stack;
        stack.reserve(code.size());
        for (const auto& instruction : code) {
            const auto op = instruction.op;
            if (op == 0) { stack.push_back({instruction.value, 0.}); continue; }
            if (op == 1) {
                auto* p = pvec.at(instruction.index);
                stack.push_back({*p, p == derivative ? 1. : 0.}); continue;
            }
            if (stack.empty()) throw std::runtime_error("Invalid sketch expression");
            auto b = stack.back(); stack.pop_back();
            if ((op >= 6 && op <= 9) || op == 11) {
                if (op == 6) { const auto r = std::sqrt(std::max(0., b.value)); b = {r, r > 1e-15 ? b.derivative / (2. * r) : 0.}; }
                if (op == 7) b = {std::sin(b.value), std::cos(b.value) * b.derivative};
                if (op == 8) b = {std::cos(b.value), -std::sin(b.value) * b.derivative};
                if (op == 9) b = {-b.value, -b.derivative};
                // Choose the positive one-sided derivative at zero separation.
                if (op == 11) b = {std::abs(b.value), b.value < 0. ? -b.derivative : b.derivative};
                stack.push_back(b); continue;
            }
            if (stack.empty()) throw std::runtime_error("Invalid sketch expression");
            auto a = stack.back(); stack.pop_back();
            Dual c{};
            switch (op) {
            case 2: c = {a.value+b.value, a.derivative+b.derivative}; break;
            case 3: c = {a.value-b.value, a.derivative-b.derivative}; break;
            case 4: c = {a.value*b.value, a.derivative*b.value+a.value*b.derivative}; break;
            case 5: if(b.value==0.) throw std::runtime_error("Division by zero"); c = {a.value/b.value, (a.derivative*b.value-a.value*b.derivative)/(b.value*b.value)}; break;
            case 10: {
                const auto norm = a.value*a.value+b.value*b.value;
                c = {std::atan2(a.value,b.value), norm > 1e-30 ? (b.value*a.derivative-a.value*b.derivative)/norm : 0.}; break;
            }
            default: throw std::runtime_error("Unknown sketch expression instruction");
            }
            if (!std::isfinite(c.value) || !std::isfinite(c.derivative)) throw std::runtime_error("Non-finite sketch equation");
            stack.push_back(c);
        }
        if (stack.size() != 1) throw std::runtime_error("Invalid sketch equation");
        return stack.back();
    }
public:
    Expression(double* values, size_t count, const PamatInstruction* instructions, size_t size, int tag) : code(instructions, instructions+size) {
        for (auto& instruction : code) if (instruction.op == 1) {
            if (instruction.index >= count) throw std::runtime_error("Invalid sketch variable");
            auto* pointer = values + instruction.index;
            auto found = std::find(pvec.begin(), pvec.end(), pointer);
            instruction.index = static_cast<uint32_t>(found-pvec.begin());
            if (found == pvec.end()) pvec.push_back(pointer);
        }
        origpvec = pvec;
        setTag(tag);
    }
    double error() override { return scale*evaluate(nullptr).value; }
    double grad(double* p) override {
        if (std::find(pvec.begin(), pvec.end(), p) == pvec.end()) return 0.;
        return scale*evaluate(p).derivative;
    }
};
}

extern "C" int pamat_sketch_solve(double* values, size_t count, size_t geometry_count, const uint8_t* fixed, const uint8_t* preferred,
    const PamatInstruction* instructions, const PamatEquation* equations, size_t equation_count, size_t permanent_count,
    const PamatDragTarget* drag, size_t drag_count, bool dragging,
    int32_t* dof, uint8_t* movable, const size_t* group_indices, const PamatVariableGroup* groups, size_t group_count, int32_t* group_dof, int32_t* diagnostic_tags, size_t* diagnostic_count,
    char* error, size_t error_size, PamatSolveProfile* profile) {
    try {
        using Clock = std::chrono::steady_clock;
        auto started = profile ? Clock::now() : Clock::time_point{};
        const auto elapsed = [&]() {
            const auto now = Clock::now();
            const double ms = std::chrono::duration<double, std::milli>(now - started).count();
            started = now;
            return ms;
        };
        const auto solve = [&](GCS::System& solver, GCS::VEC_pD& unknowns) {
            if (profile) profile->prepare_ms += elapsed();
            solver.declareUnknowns(unknowns);
            solver.initSolution();
            if (profile) profile->diagnose_ms += elapsed();
            const int result = solver.solve();
            solver.applySolution();
            if (profile) profile->solve_ms += elapsed();
            return result;
        };
        GCS::System system;
        system.debugMode = GCS::NoDebug;
        system.maxIter = 200;
        std::vector<Expression*> constraints;
        for (size_t i=0; i<permanent_count; ++i) {
            const auto& equation = equations[i];
            auto* constraint = new Expression(values,count,instructions+equation.start,equation.count,equation.tag);
            system.addConstraint(constraint);
            constraints.push_back(constraint);
        }
        GCS::VEC_pD parameters;
        std::vector<size_t> active;
        for (size_t i=0; i<geometry_count; ++i) if(!fixed[i]) { parameters.push_back(values+i); active.push_back(i); }
        int status = GCS::Success;
        if (dragging) {
            // The permanent equations below also supply the final residual/DOF checks.
            // Drag targets and position preferences exist only in these temporary systems.
            std::vector<double> original(values, values + count);
            std::vector<double> seed = original;
            std::vector<size_t> indices;
            std::vector<double> target;
            std::vector<bool> targeted(count, false);
            for (size_t i = 0; i < drag_count; ++i) {
                if (drag[i].x >= count || drag[i].y >= count) throw std::runtime_error("Invalid drag point");
                indices.push_back(drag[i].x); indices.push_back(drag[i].y);
                target.push_back(drag[i].position[0]); target.push_back(drag[i].position[1]);
                targeted[drag[i].x] = targeted[drag[i].y] = true;
            }
            const auto attempt = [&](bool pin, bool preserve, bool holdPreferred = false) {
                if (profile) ++profile->attempts;
                std::copy(seed.begin(), seed.end(), values);
                for (size_t axis = 0; axis < indices.size(); ++axis) if (pin) {
                    const size_t i = indices[axis];
                    if (fixed[i] && std::abs(values[i] - target[axis]) > 1e-9) return false;
                    if (!fixed[i]) values[i] = target[axis];
                }
                GCS::System move;
                move.debugMode = GCS::NoDebug;
                move.maxIter = 200;
                std::vector<Expression*> relations;
                for (size_t i = 0; i < equation_count; ++i) {
                    const auto& e = equations[i];
                    auto* relation = new Expression(values, count, instructions + e.start, e.count, e.tag);
                    move.addConstraint(relation);
                    relations.push_back(relation);
                }
                if (holdPreferred) for (size_t i=0; i<count; ++i) if (preferred[i]) values[i] = original[i];
                GCS::VEC_pD unknowns;
                // Keep auxiliary objectives out of PlaneGCS's redundancy proof.
                // An unreachable cursor must not make valid redundant geometry look conflicting.
                // Negative-tag constraints still participate in the auxiliary drag solve.
                for (size_t i = 0; i < count; ++i) {
                    if (fixed[i] || (pin && targeted[i]) || (holdPreferred && preferred[i])) continue;
                    unknowns.push_back(values + i);
                    if (preserve) move.addConstraintEqual(values + i, original.data() + i, GCS::DefaultTemporaryConstraint, false);
                }
                if (!pin) for (size_t axis = 0; axis < indices.size(); ++axis) {
                    move.addConstraintEqual(values + indices[axis], target.data() + axis, GCS::DefaultTemporaryConstraint, false);
                }
                const int result = unknowns.empty() ? GCS::Success : solve(move, unknowns);
                if (result != GCS::Success && result != GCS::Converged) return false;
                for (auto* constraint : relations) {
                    const double error = constraint->error();
                    if (!std::isfinite(error) || std::abs(error) > 1e-7) return false;
                }
                return std::all_of(values, values + count, [](double v) { return std::isfinite(v); });
            };
            // First try the exact cursor with minimum movement elsewhere. If permanent
            // constraints prevent that, find an attainable cursor position, then retain it
            // while minimizing the remaining movement. Preferences never weaken geometry.
            const bool hasPreferred = std::any_of(preferred, preferred + count, [](uint8_t p) { return p != 0; });
            // With no cursor in this component, an already valid input has the
            // exact minimum movement (zero). Keep its bits rather than introduce
            // numerical drift. Residuals and freedom are still recomputed below.
            const bool unchanged = !drag_count && std::all_of(constraints.begin(), constraints.end(), [](auto* relation) {
                const double residual = relation->error();
                return std::isfinite(residual) && std::abs(residual) <= 1e-7;
            });
            if (!unchanged && !(hasPreferred && attempt(true, true, true)) && !attempt(true, true)) {
                if (!attempt(false, false)) throw std::runtime_error("Could not solve sketch drag");
                for (size_t axis = 0; axis < indices.size(); ++axis) target[axis] = values[indices[axis]];
                // Diagnose the pinned system at the feasible solution, while retaining
                // original positions as the minimum-movement preferences.
                seed.assign(values, values + count);
                if (!attempt(true, true)) throw std::runtime_error("Could not preserve sketch drag target");
            }
        } else {
            status = equation_count && !active.empty() ? solve(system, parameters) : GCS::Success;
        }
        GCS::VEC_I conflicts;
        system.getConflicting(conflicts);
        size_t capacity = *diagnostic_count;
        *diagnostic_count = std::min(capacity, conflicts.size());
        std::copy_n(conflicts.begin(), *diagnostic_count, diagnostic_tags);
        if (profile) profile->prepare_ms += elapsed();
        Eigen::MatrixXd jacobian(permanent_count, active.size());
        double residual = 0.;
        for (size_t i=0; i<permanent_count; ++i) {
            residual = std::max(residual,std::abs(constraints[i]->error()));
            for (size_t j=0; j<active.size(); ++j) jacobian(i,j)=constraints[i]->grad(values+active[j]);
        }
        if (profile) profile->jacobian_ms += elapsed();
        std::fill_n(movable,count,0);
        for(auto i:active)movable[i]=1;
        *dof = static_cast<int32_t>(active.size());
        Eigen::MatrixXd nullspace;
        if (!active.empty() && permanent_count) {
            Eigen::JacobiSVD<Eigen::MatrixXd> svd(jacobian,Eigen::ComputeFullV);
            svd.setThreshold(1e-9);
            const auto rank = svd.rank();
            *dof = static_cast<int32_t>(active.size()-rank);
            nullspace = svd.matrixV().rightCols(*dof);
            for (size_t i=0; i<active.size(); ++i)
                movable[active[i]] = nullspace.row(i).squaredNorm() > 1e-12;
        } else {
            nullspace = Eigen::MatrixXd::Identity(active.size(), active.size());
        }
        std::vector<int> free_column(count, -1);
        for(size_t i=0; i<active.size(); ++i) free_column[active[i]]=static_cast<int>(i);
        for(size_t g=0; g<group_count; ++g) {
            const auto& group=groups[g];
            Eigen::MatrixXd freedom=Eigen::MatrixXd::Zero(group.count,*dof);
            for(size_t j=0; j<group.count; ++j) {
                const auto index=group_indices[group.start+j];
                if(index>=count) throw std::runtime_error("Invalid sketch freedom group");
                if(free_column[index]>=0) freedom.row(j)=nullspace.row(free_column[index]);
            }
            group_dof[g]=0;
            if(group.count && *dof) {
                Eigen::JacobiSVD<Eigen::MatrixXd> svd(freedom);
                // Global nullspace rows are dimensionless and bounded by one.
                const auto singular=svd.singularValues();
                group_dof[g]=static_cast<int32_t>((singular.array()>1e-7).count());
            }
        }
        if (profile) profile->freedom_ms += elapsed();
        // A solver convergence flag alone does not guarantee satisfied constraints.
        if (!std::isfinite(residual) || residual > 1e-7) {
            std::snprintf(error,error_size,"Sketch constraints conflict or did not converge (residual %.9g, status %d)",residual,status);
            return 1;
        }
        return 0;
    } catch (const std::exception& e) {
        std::snprintf(error,error_size,"%s",e.what()); return 1;
    }
}
