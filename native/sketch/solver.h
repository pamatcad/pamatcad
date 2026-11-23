#pragma once
#include <stddef.h>
#include <stdint.h>
struct PamatInstruction { uint32_t op, index; double value; };
struct PamatVariableGroup { size_t start, count; };
struct PamatEquation { size_t start, count; int32_t tag; };
struct PamatDragTarget { size_t x, y; double position[2]; };
extern "C" int pamat_sketch_solve(double* values, size_t count, const uint8_t* fixed,
    const PamatInstruction* instructions, const PamatEquation* equations, size_t equation_count,
    const PamatDragTarget* drag, size_t drag_count,
    int32_t* dof, uint8_t* movable, const size_t* group_indices, const PamatVariableGroup* groups, size_t group_count, int32_t* group_dof, int32_t* diagnostic_tags, size_t* diagnostic_count,
    char* error, size_t error_size);
