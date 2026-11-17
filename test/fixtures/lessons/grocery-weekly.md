Lessons from the weekly order run

    The quantity stepper mangled the value when I used the + button.
    What went wrong: I clicked + mid-entry, then typed the rest. The box came out as "21.5" instead of "1.5", and Backspace didn't fix it.
    What worked: type the whole value straight into the "Quantity" box in one go, e.g. 1.5. This shows correctly and registers on Add to cart.
    Belongs in: "Adding items → Quantity boxes, what works". Add: "Type the whole value with browser_type. Don't use the + and - buttons mid-entry."
    Typing 1/2 for half doesn't register as 0.5.
    What went wrong: the box rounds it to 1.
    What worked: type 0.5.
    Belongs in: "Choosing items". Add: "Use decimals for part quantities."
    A stale quantity ref sent a second amount into the first box.
    What went wrong: I typed item 2's amount into item 1's old "Quantity" ref, so the box showed "1.53".
    What worked: reload the cart with browser_navigate to the …/cart/last URL. That restores the last saved cart. Then click each box, type, and leave it, with a fresh browser_read between boxes.
    Belongs in: "Loop → step 3". Add: "The 'Quantity' textbox ref changes every time a box is clicked. Re-read it for each box."
    The page re-renders the cart for about 5–10 seconds after a load or an add.
    What went wrong: clicks in that window did nothing, or boxes looked empty.
    What worked: browser_wait for 4–5 seconds and take a screenshot. Click only once the quantity boxes are drawn.
    Belongs in: "What the site looks like", after the line about refs shifting after an add.
    Weighted items at the deli counter.
    What worked: click Weight, type the number, press Tab to reach the unit menu and pick lb.
    Belongs in: "Adding items", as an example for items such as sliced turkey.
    Add to cart refs:
    The skill says the first Add to cart after an item's Details link belongs to that item. That held for every item.
    Add this note: refs for other items shift by one after each add, so re-read the list every time.
    Belongs in: "Loop → step 5".
    Plain note boxes: a box with no stepper (item 6's delivery note) accepted browser_type directly and registered on save, as the skill says.
    Wrong instruction: none. Everything else in the skill was accurate.
