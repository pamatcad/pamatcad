cmake_minimum_required(VERSION 3.24)
project(PamatCADGeometry LANGUAGES CXX)
include(ExternalProject)
include(dependencies.cmake)

set(occt_install "${CMAKE_BINARY_DIR}/occt-${PAMATCAD_OCCT_VERSION}-install")
set(occt_options
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DBUILD_LIBRARY_TYPE=Static -DBUILD_RELEASE_DISABLE_EXCEPTIONS=OFF
  -DCMAKE_EXPORT_NO_PACKAGE_REGISTRY=ON
  -DUSE_FREETYPE=OFF -DUSE_TK=OFF -DUSE_TCL=OFF -DUSE_XLIB=OFF -DUSE_OPENGL=OFF
  "-DBUILD_ADDITIONAL_TOOLKITS=TKBO TKMesh TKDESTEP"
  "-DINSTALL_DIR=${occt_install}"
  -DINSTALL_DIR_INCLUDE=include/opencascade -DINSTALL_DIR_LIB=lib)
foreach(module FoundationClasses ModelingData ModelingAlgorithms Visualization ApplicationFramework DataExchange Draw)
  list(APPEND occt_options "-DBUILD_MODULE_${module}=OFF")
endforeach()
ExternalProject_Add(occt_build
  PREFIX "${CMAKE_BINARY_DIR}/occt-${PAMATCAD_OCCT_VERSION}-prefix"
  SOURCE_DIR "${occt_SOURCE_DIR}"
  BINARY_DIR "${CMAKE_BINARY_DIR}/occt-${PAMATCAD_OCCT_VERSION}"
  DOWNLOAD_COMMAND "" UPDATE_COMMAND ""
  CMAKE_ARGS ${occt_options}
  BUILD_COMMAND "${CMAKE_COMMAND}" --build <BINARY_DIR> --config Release --parallel 4
  INSTALL_COMMAND "${CMAKE_COMMAND}" --install <BINARY_DIR> --config Release
  LOG_CONFIGURE TRUE LOG_BUILD TRUE LOG_INSTALL TRUE LOG_OUTPUT_ON_FAILURE TRUE)

add_library(pamatcad_occt STATIC bridge.cpp scene_io.cpp)
target_compile_features(pamatcad_occt PRIVATE cxx_std_17)
target_include_directories(pamatcad_occt SYSTEM PRIVATE "${occt_install}/include/opencascade")
add_dependencies(pamatcad_occt occt_build)
install(TARGETS pamatcad_occt ARCHIVE DESTINATION lib)
install(DIRECTORY "${occt_install}/lib/" DESTINATION lib
  FILES_MATCHING PATTERN "*.a" PATTERN "*.lib")

