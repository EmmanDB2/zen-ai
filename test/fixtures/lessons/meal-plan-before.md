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
4. Type the last field, then click **Save day** right away to save it.
5. Move on with **Next day**.

## Entering servings
- Number fields: type digits only, no commas.
- Table cells with no refs: flag them for the user to enter by hand.

## Reporting
- At the end, list each day with the totals shown on the page.
