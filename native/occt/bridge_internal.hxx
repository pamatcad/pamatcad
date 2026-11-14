#pragma once
#include "bridge.h"
#include <Standard_Failure.hxx>
#include <TopoDS_Shape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <cstdio>
#include <exception>
#include <stdexcept>
#include <vector>

struct PamatShape {
    TopoDS_Shape value;
    // Cap slots come first (end 1, then start or end 2), followed by source edges
    // for each side. Booleans update the descendants without moving the slots.
    std::vector<TopTools_IndexedMapOfShape> named_faces;
};

double validated_volume(const TopoDS_Shape& solid);

template <typename Operation>
static int checked(Operation operation, char* error, size_t error_size) noexcept {
    try {
        operation();
        return 0;
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        std::snprintf(error, error_size, "%s", message ? message : "OCCT failure");
    } catch (const std::invalid_argument& failure) {
        std::snprintf(error, error_size, "%s", failure.what());
        return 2;
    } catch (const std::exception& failure) {
        std::snprintf(error, error_size, "%s", failure.what());
    } catch (...) {
        std::snprintf(error, error_size, "Unknown OCCT failure");
    }
    return 1;
}

