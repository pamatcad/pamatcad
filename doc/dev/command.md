# Command workflow

Commands are documented `../api/command`. 

## Required spec format

Use these headings in order. Write `Open` beside a question that needs a decision. Use `N/A` with a reason when a section does not apply, or `TK` when the section needs to be completed.

- Scope: is it a solid, sheet metal operation, sketch constraint or something else?
- Intent: general description, used in user guide and SDK
- Inputs: valid input geometry and validation rules
- Parameters: parameter schema, including validation rules and conditional processing
- Preview, results and effects: what is returned after this operation, what are the effects and results
- Topology and references: resulting topology description 
- Errors: error code definition
- Test cases: cases that need to pass
- History: implementation history

## Rules

- feature specs must be consistent and match the format
- Write Scope through Errors as rules for every valid use of the command or named mode. Put scenario-specific geometry, dimensions, selections, call sequences, and expected results in Test cases. Units, defaults, tolerances, and limits that define the contract belong with the relevant input or parameter.
- State each contract rule once. When a section already covers a rule, edit that passage. Record current implementation coverage in History.
- no test should be generated if it is not documented in the test cases, and no test case should be accepted if it contradicts the scope or intent, or uses undocumented inputs and parameters
- new features should not break the consistency of the code, SDK, protocol, UI, or implementation 

## Workflow and artifacts

- spec.md: specification
- operation.json: agent-generated spec file

TK: documentation
TK: protocol generation
