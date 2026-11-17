---
name: meal-plan
description: Fill in this week's meal plan on the meal-planner site in the open tab.
lessons: true
---
# Meal planner runner

## Scope and safety
- Work only in the tab the user has open.
- Never click **Submit** on the grocery order. The user submits it.
- Running this skill authorizes: entering servings and moving between days.

## Loop
1. `browser_read` the day.
2. Work out every meal.
3. Enter each servings field with `browser_type`.
4. After the last field, type one extra digit, press Backspace and wait 3 seconds so the value sticks. Check it by leaving the day and returning.
5. Click **Save day** only after that check: it locks the day.
6. Move on with **Next day**.

## Entering servings
- Number fields: type digits only, no commas.
- Table cells with no refs: click the cell, press Enter, type into the new textbox, press Enter. Fill them in row order and wait 3 seconds before leaving.

## Choosing meals
- For typed ingredient fields, use the ingredient name the site's pantry list uses (for example "scallion", not "green onion"). After a miss, the "Did you mean" box lists the names it accepts.

## Reporting
- At the end, list each day with the totals shown on the page. Number-field totals aren't in the page text: use a screenshot, and for table days look for the "Day is complete" banner.
