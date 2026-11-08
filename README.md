# PamatCAD

PamatCAD is a free and open source suite of CAD/CAM components. The goal of the project is to create a CAD/CAM core app, that can be embedded, interacted with via API, scripted, or used as a part of a desktop application, while sharing the protocol and data structures.

PamatCAD is not an attempt to recreate, clone, or imitate existing CAD solutions. Any similar workflows and interfaces is a result of a similar requirements being implemented.

The name comes from a Latvian word "Pamats", meaning "base", or "foundation".

# Target uses

- standalone desktop application, working on up-to-date Linux, Windows, and MacOS machines
- cli tool that can execute CAD workflows from a save file (e.g. generate and export multiple configurations of the same model)
- API server that allows to execute commands (externally scripted CAD)
- web-based CAD application for online and offline editing
- embedded engine for custom applications and configurators, both web and desktop

# Development principles

Use the [feature workflow](doc/dev/command.md) to write an operation spec, approve a delivery, verify it, and hand it off to another contributor or session.

# Components 

TK

# Testing

TK

# FAQ

## Why another CAD app? We have XXX!

FreeCad is slow to implement features, ugly and lacks CAM features. Lots of vibe coded apps, including SolidCraft, focus on recreating existing apps (e.g. Fusion), rather than create a polished and clean implementation. OpenSCAD is more of a coding platform, but PamatCAD SDK and scripting API are heavily influenced by OpenSCAD. PamatCAD is not a purist CAD implementation; it is an app created for people to collaborate and create. 
