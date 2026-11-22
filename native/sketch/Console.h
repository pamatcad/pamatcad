#pragma once
#include <cstdarg>
#include <cstdio>
// PlaneGCS's diagnostics use this small portable adapter instead of its JS console.
struct Console {
    static void Log(const char* format, ...) {
        va_list args;
        va_start(args, format);
        std::vfprintf(stderr, format, args);
        va_end(args);
    }
};
