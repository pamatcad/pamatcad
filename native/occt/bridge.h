#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif
typedef struct PamatShape PamatShape;
int pamat_extrude(const double* points, size_t count, const double* direction,
                  PamatShape** output, char* error, size_t error_size);
int pamat_extrude_circle(const double* center, double radius, const double* normal,
                         const double* direction, PamatShape** output, char* error, size_t error_size);
int pamat_cut(const PamatShape* body, const PamatShape* tool,
              PamatShape** output, char* error, size_t error_size);
size_t pamat_face_count(const PamatShape* shape, size_t face_id);
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

