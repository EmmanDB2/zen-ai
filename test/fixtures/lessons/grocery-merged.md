---
name: grocery
description: Fill the grocery cart from the user's shopping list in the open tab.
lessons: true
---
# Grocery cart runner

## Scope and safety
- Work only in the tab the user has open.
- Never click **Submit Order**. The user submits it.
- Running this skill authorizes: adding items to the cart and changing quantities.
- Stop and tell the user about logins, timeouts, CAPTCHAs, errors or anything unexpected.

## What the site looks like
- Each item has a Details link, a "Quantity" box with + and - buttons, and an **Add to cart** button.
- Refs shift after every add: re-read before the next click.
- The cart re-renders for about 5 to 10 seconds after a load or an add. `browser_wait` 4 to 5 seconds and take a screenshot; click only once the quantity boxes are drawn.

## Loop (repeat per item)
1. `browser_read` the list.
2. Find the item on the site.
3. Click its "Quantity" box and type. The box's ref changes every time a box is clicked, so re-read it for each box.
4. Check the value with a close-up `browser_screenshot` with `ref`.
5. Click **Add to cart**. The first **Add to cart** after an item's Details link belongs to that item; refs for other items shift by one after each add, so re-read the list every time.
6. If a box shows a stale value, reload the cart with `browser_navigate` to the `…/cart/last` URL. It restores the last saved cart.

## Adding items
- Quantity boxes, what works: type the whole value with `browser_type`. Don't use the + and - buttons mid-entry.
- Weighted items (deli counter, for example sliced turkey): click **Weight**, type the number, press Tab to reach the unit menu and pick lb.
- Plain boxes with no stepper (delivery notes) take `browser_type` directly.

## Choosing items
- Use decimals for part quantities (0.5, not 1/2).
- Pick the store brand unless the list names one.

## Reporting
- At the end, list what was added, what was out of stock, and the cart total shown on the page.
