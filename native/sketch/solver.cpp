#include "solver.h"
#include <GCS.h>
#include <Eigen/SVD>
#include <algorithm>
#include <cmath>
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
            if (op >= 6 && op <= 9) {
                if (op == 6) { const auto r = std::sqrt(std::max(0., b.value)); b = {r, r > 1e-15 ? b.derivative / (2. * r) : 0.}; }
                if (op == 7) b = {std::sin(b.value), std::cos(b.value) * b.derivative};
                if (op == 8) b = {std::cos(b.value), -std::sin(b.value) * b.derivative};
                if (op == 9) b = {-b.value, -b.derivative};
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
    double grad(double* p) override { return scale*evaluate(p).derivative; }
};
}

extern "C" int pamat_sketch_solve(double* values, size_t count, const uint8_t* fixed,
    const PamatInstruction* instructions, const PamatEquation* equations, size_t equation_count,
    int32_t* dof, uint8_t* movable, const size_t* group_indices, const PamatVariableGroup* groups, size_t group_count, int32_t* group_dof, int32_t* diagnostic_tags, size_t* diagnostic_count,
    char* error, size_t error_size) {
    try {
        GCS::System system;
        system.debugMode = GCS::NoDebug;
        system.maxIter = 200;
        std::vector<Expression*> constraints;
        for (size_t i=0; i<equation_count; ++i) {
            const auto& equation = equations[i];
            auto* constraint = new Expression(values,count,instructions+equation.start,equation.count,equation.tag);
            system.addConstraint(constraint);
            constraints.push_back(constraint);
        }
        GCS::VEC_pD parameters;
        std::vector<size_t> active;
        for (size_t i=0; i<count; ++i) if(!fixed[i]) { parameters.push_back(values+i); active.push_back(i); }
        const int status = equation_count && !active.empty() ? system.solve(parameters) : 0;
        if (equation_count && !active.empty()) system.applySolution();
        GCS::VEC_I conflicts;
        system.getConflicting(conflicts);
        size_t capacity = *diagnostic_count;
        *diagnostic_count = std::min(capacity, conflicts.size());
        std::copy_n(conflicts.begin(), *diagnostic_count, diagnostic_tags);
        Eigen::MatrixXd jacobian(equation_count, active.size());
        double residual = 0.;
        for (size_t i=0; i<equation_count; ++i) {
            residual = std::max(residual,std::abs(constraints[i]->error()));
            for (size_t j=0; j<active.size(); ++j) jacobian(i,j)=constraints[i]->grad(values+active[j]);
        }
        std::fill_n(movable,count,0);
        for(auto i:active)movable[i]=1;
        *dof = static_cast<int32_t>(active.size());
        Eigen::MatrixXd nullspace;
        if (!active.empty() && equation_count) {
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
