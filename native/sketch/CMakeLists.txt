include(FetchContent)
FetchContent_Declare(planegcs
  URL https://codeload.github.com/Salusoft89/planegcs/tar.gz/9d26baef0b240fe0eef4186d4e5e5e66ec3620b7
  URL_HASH SHA256=6641e73b41f638621d5f95ae35dfadb45b42c1e43afbeab613753de851566be3
  DOWNLOAD_EXTRACT_TIMESTAMP FALSE SOURCE_SUBDIR unused)
FetchContent_Declare(eigen
  URL https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz
  URL_HASH SHA256=8586084f71f9bde545ee7fa6d00288b264a2b7ac3607b974e54d13e7162c1c72
  DOWNLOAD_EXTRACT_TIMESTAMP FALSE SOURCE_SUBDIR unused)
FetchContent_Declare(boost
  URL https://archives.boost.io/release/1.86.0/source/boost_1_86_0.tar.bz2
  URL_HASH SHA256=1bed88e40401b2cb7a1f76d4bab499e352fa4d0c5f31c0dbae64e24d34d7513b
  DOWNLOAD_EXTRACT_TIMESTAMP FALSE SOURCE_SUBDIR unused)
FetchContent_MakeAvailable(planegcs eigen boost)
set(gcs ${planegcs_SOURCE_DIR}/planegcs)
add_library(pamatcad_sketch STATIC solver.cpp ${gcs}/GCS.cpp ${gcs}/Geo.cpp
  ${gcs}/Constraints.cpp ${gcs}/SubSystem.cpp ${gcs}/qp_eq.cpp)
target_compile_features(pamatcad_sketch PRIVATE cxx_std_20)
target_include_directories(pamatcad_sketch PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_include_directories(pamatcad_sketch SYSTEM PRIVATE ${gcs} ${gcs}/headers ${eigen_SOURCE_DIR} ${boost_SOURCE_DIR})
set_target_properties(pamatcad_sketch PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(EMSCRIPTEN)
  target_compile_options(pamatcad_sketch PRIVATE -fexceptions)
endif()
install(TARGETS pamatcad_sketch ARCHIVE DESTINATION lib)
install(FILES ${planegcs_SOURCE_DIR}/LICENSE DESTINATION share/pamatcad/licenses RENAME PlaneGCS.txt)
