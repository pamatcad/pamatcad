# Scene browser

Scene browser is a tabbed panel that lists all objects in the scene. There is no caption, but there are tabs and a button to collapse the browser to the left. The browser right side is resizeable.

## General tab behaviour

Each tab starts with an icon a tab name which is visible only when the tab is open. Tabs, in sequence, are: Components, Construction, Bodies and Sketches. Tabs switch contextually after a corresponding object has been created - e.g. after a new body is created, a "Bodies" tab becomes active. 

Each tab displays a tree, since even flat lists (bodies) can have groups. Each item in tree view is clearly visually nested, and each item is prefixes with a show/hide (eye) icon and a type icon. Clicking and object in the object browser highlights it in the viewport, and vice versa - clicking and object or a face in the viewport highlights it in the browser.

Tab state, including the state of the tree, is persisted between sessions, but can be reset via Help → Reset UI.