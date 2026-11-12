#pragma once
#include "bridge.h"
#include <Standard_Failure.hxx>
#include <TopoDS_Shape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <cstdio>
#include <exception>
#include <vector>

struct PamatShape {
    TopoDS_Shape value;
    // Slot zero belongs to the prism end cap. Further slots retain faces selected by a client.
    std::vector<TopTools_IndexedMapOfShape> named_faces;
};

template <typename Operation>
static int checked(Operation operation, char* error, size_t error_size) noexcept {
    try {
        operation();
        return 0;
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        std::snprintf(error, error_size, "%s", message ? message : "OCCT failure");
    } catch (const std::exception& failure) {
        std::snprintf(error, error_size, "%s", failure.what());
    } catch (...) {
        std::snprintf(error, error_size, "Unknown OCCT failure");
    }
    return 1;
}

