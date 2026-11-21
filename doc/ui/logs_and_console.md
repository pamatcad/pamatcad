# Console execution

While a script runs, Run becomes Stop. Stop terminates the JavaScript worker, waits for already dispatched CAD commands, then refreshes the scene and restores editing. Completed model edits remain. Scripts have no automatic time limit. This behavior also applies to the detached console.

# CAD log timing

Each command shows elapsed milliseconds on the right, with one decimal place. Timing runs from dispatch through response or failure, including queueing and communication; it excludes input debounce and viewport rendering. Pending commands show `…`.

## Test cases

- Successful and failed commands receive timings in their own rows. A held command stays pending while another request completes; its elapsed time includes the hold.
- Times align to the right in docked and detached output, and survive docking with the command history.
