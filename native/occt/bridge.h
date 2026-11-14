#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif
typedef struct PamatShape PamatShape;
typedef struct {
    const PamatShape* target;
    double length;       // Signed along the profile normal, or resolved bounding reach.
    double taper;        // Outward angle in radians.
    int extent;          // 0 fixed, 1 closest, 2 touch, 3 intersect, 4 farthest.
} PamatExtrudeSide;
typedef struct {
    double normal[3];
    double origin[3];
    double offset;
    PamatExtrudeSide sides[2];
    int two_sides;
} PamatExtrusion;
int pamat_extrude(const double* points, size_t count, const PamatExtrusion* options,
                  PamatShape** output, char* error, size_t error_size);
int pamat_extrude_circle(const double* center, double radius, const PamatExtrusion* options,
                         PamatShape** output, char* error, size_t error_size);
int pamat_extrude_face(const PamatShape* body, size_t face_id, const PamatExtrusion* options,
                       PamatShape** output, char* error, size_t error_size);
int pamat_axial_bounds(const PamatShape* body, size_t face_id, const double* origin,
                       const double* normal, double* bounds, char* error, size_t error_size);
int pamat_face_properties(const PamatShape* body, size_t face_id, double* properties,
                          int* surface_type, char* error, size_t error_size);
// A partition borrows its target and tool shapes until freed. Group indices refer
// to the corresponding input array. The arrays in a group live with the partition.
typedef struct PamatPartition PamatPartition;
typedef struct {
    const size_t* targets;
    size_t target_count;
    const size_t* tools;
    size_t tool_count;
} PamatCellGroup;
int pamat_partition(const PamatShape* const* targets, size_t target_count,
                    const PamatShape* const* tools, size_t tool_count, int join,
                    PamatPartition** output, size_t* group_count, char* error, size_t error_size);
PamatCellGroup pamat_partition_group(const PamatPartition* partition, size_t index);
// Null output means complete consumption (cut) or no effect (join). Slots are ordered by survivor,
// then other group targets, then group tools.
int pamat_partition_result(PamatPartition* partition, size_t group, size_t survivor,
                           PamatShape** output, int* material_changed, char* error, size_t error_size);
void pamat_partition_free(PamatPartition* partition);
size_t pamat_face_count(const PamatShape* shape, size_t face_id);
size_t pamat_face_slots(const PamatShape* shape);
int pamat_face_ids(PamatShape* shape, size_t first, size_t count, void (*sink)(void*, size_t), void* context,
                   char* error, size_t error_size);
int pamat_face_frame(const PamatShape* shape, size_t face_id, double* frame, char* error, size_t error_size);
int pamat_face_by_normal(PamatShape* shape, const double* normal, size_t* count, size_t* face_id,
                         char* error, size_t error_size);
int pamat_volume(const PamatShape* shape, double* output, char* error, size_t error_size);
typedef void (*PamatBytes)(void* context, const unsigned char* data, size_t length);
typedef void (*PamatTriangle)(void* context, const double* xyz);
int pamat_write_step(const PamatShape* const* shapes, size_t count, PamatBytes sink, void* context,
                     char* error, size_t error_size);
int pamat_mesh(const PamatShape* shape, PamatTriangle sink, void* context, char* error, size_t error_size);
void pamat_shape_free(PamatShape* shape);
#ifdef __cplusplus
}
#endif

