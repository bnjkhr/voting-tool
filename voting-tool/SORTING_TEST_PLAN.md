# Test Plan: Sorting Implementation Verification

## Overview
This test plan verifies that suggestions with the tag "ist umgesetzt" (completed) are moved to the bottom of the list, while open suggestions remain at the top. The sorting should work in both the main user interface and the admin interface.

## Test Environment Setup

### Prerequisites
1. Access to the voting tool application
2. Admin credentials for the admin interface
3. At least one app created in the system
4. Test data with various suggestion states and vote counts

### Test Interfaces
- **Main Interface**: `http://localhost:3000/` (or deployed URL)
- **Admin Interface**: `http://localhost:3000/admin.html`
- **Test Interface**: `http://localhost:3000/test.html` (for creating test data)

## Test Data Creation

### Step 1: Create Test App
1. Navigate to admin interface
2. Create a new test app: "Sort Test App"
3. Note the app ID for later use

### Step 2: Create Test Suggestions
Use the test.html interface or admin interface to create suggestions with different properties:

#### Test Scenario A: Mixed Tags and Vote Counts
Create suggestions in this order (to test sorting overrides creation order):

1. **Suggestion A1**: 
   - Title: "High votes completed"
   - Description: "Test suggestion with high votes and completed tag"
   - Tag: "ist umgesetzt"
   - Votes: 15 (manually add votes via voting)

2. **Suggestion A2**:
   - Title: "Low votes open" 
   - Description: "Test suggestion with low votes and no tag"
   - Tag: null
   - Votes: 2

3. **Suggestion A3**:
   - Title: "Medium votes completed"
   - Description: "Test suggestion with medium votes and completed tag"
   - Tag: "ist umgesetzt"
   - Votes: 8

4. **Suggestion A4**:
   - Title: "High votes open"
   - Description: "Test suggestion with high votes and no tag"
   - Tag: null
   - Votes: 12

5. **Suggestion A5**:
   - Title: "Medium votes other tag"
   - Description: "Test suggestion with medium votes and different tag"
   - Tag: "wird umgesetzt"
   - Votes: 6

#### Test Scenario B: All Same Vote Counts
Create suggestions with identical vote counts to test secondary sorting:

1. **Suggestion B1**: Tag: null, Votes: 5, Created: Oldest
2. **Suggestion B2**: Tag: "ist umgesetzt", Votes: 5, Created: Middle
3. **Suggestion B3**: Tag: null, Votes: 5, Created: Newest
4. **Suggestion B4**: Tag: "ist umgesetzt", Votes: 5, Created: Newest

#### Test Scenario C: Edge Cases
1. **Suggestion C1**: No tag, 0 votes
2. **Suggestion C2**: "ist umgesetzt" tag, 0 votes
3. **Suggestion C3**: Other tag ("wird nicht umgesetzt"), 0 votes

## Manual Testing Steps

### Test 1: Main Interface Sorting Verification

#### 1.1 Basic Sorting Test
1. Navigate to main interface
2. Select "Sort Test App"
3. **Expected Result**: 
   - All suggestions WITHOUT "ist umgesetzt" tag appear first
   - All suggestions WITH "ist umgesetzt" tag appear last
   - Within each group, suggestions are sorted by vote count (descending)
   - For equal vote counts, newer suggestions appear first

#### 1.2 Verify Test Scenario A Order
For Test Scenario A, the expected order should be:
1. "High votes open" (12 votes, no tag)
2. "Medium votes other tag" (6 votes, "wird umgesetzt")
3. "Low votes open" (2 votes, no tag)
4. "High votes completed" (15 votes, "ist umgesetzt") ← *completed group*
5. "Medium votes completed" (8 votes, "ist umgesetzt") ← *completed group*

#### 1.3 Verify Test Scenario B Order
For Test Scenario B (all 5 votes), the expected order should be:
1. "Suggestion B3" (newest, no tag)
2. "Suggestion B1" (oldest, no tag)
3. "Suggestion B4" (newest, "ist umgesetzt") ← *completed group*
4. "Suggestion B2" (middle, "ist umgesetzt") ← *completed group*

#### 1.4 Visual Verification
- Completed suggestions ("ist umgesetzt") should appear with reduced opacity (0.5)
- Vote buttons should be disabled for completed suggestions
- Tag badges should correctly show "ist umgesetzt" for completed items

### Test 2: Admin Interface Sorting Verification

#### 2.1 Admin List Sorting
1. Navigate to admin interface
2. **Expected Result**: Same sorting logic as main interface
3. Additional admin-specific sorting: Pending suggestions (not approved) should appear before approved ones within each group

#### 2.2 Verify Admin-Specific Order
For suggestions with different approval statuses:
1. Open, not approved, high votes
2. Open, not approved, low votes  
3. Open, approved, high votes
4. Open, approved, low votes
5. Completed, not approved, high votes ← *completed group*
6. Completed, approved, low votes ← *completed group*

#### 2.3 Visual Elements in Admin
- Completed suggestions should have reduced opacity
- Tag dropdown should show "ist umgesetzt" for completed suggestions
- Status badges should show approval status

### Test 3: Dynamic Sorting Tests

#### 3.1 Tag Change Impact
1. Select an open suggestion in admin interface
2. Change its tag to "ist umgesetzt"
3. **Expected Result**: Suggestion immediately moves to bottom section
4. Refresh main interface and verify the same change

#### 3.2 Vote Impact on Open Suggestions
1. Vote for an open suggestion in main interface
2. **Expected Result**: Suggestion moves up within the open section based on new vote count
3. Completed suggestions should not be affected by voting (buttons disabled)

#### 3.3 Vote Impact on Completed Suggestions
1. Try to vote for a completed suggestion
2. **Expected Result**: Vote button should be disabled, no voting possible
3. Order of completed suggestions should remain unchanged

### Test 4: Filter Interaction Tests

#### 4.1 Filter Preserves Sorting
1. In main interface, apply different filters
2. **Expected Result**: Within each filtered view, the same sorting logic applies
3. "Ist umgesetzt" filter should only show completed suggestions, still sorted by votes

#### 4.2 Filter Count Verification
1. Check filter pill counts
2. **Expected Result**: Counts accurately reflect number of suggestions in each category
3. "Ist umgesetzt" count should match number of completed suggestions

## API Testing Steps

### Test 5: Direct API Verification

#### 5.1 Main API Endpoint Test
```bash
# Replace APP_ID with actual test app ID
curl "http://localhost:3000/api/apps/APP_ID/suggestions"
```
**Expected Result**: JSON response with suggestions sorted according to rules

#### 5.2 Admin API Endpoint Test  
```bash
# Requires admin authorization
curl -H "Authorization: Bearer ADMIN_PASSWORD" \
     "http://localhost:3000/api/admin/suggestions"
```
**Expected Result**: JSON response with admin-specific sorting

## Expected Results Summary

### Sorting Logic Priority
1. **Primary**: Completion status (open vs "ist umgesetzt")
2. **Secondary**: Vote count (descending)
3. **Tertiary**: Creation date (descending)
4. **Admin-only**: Approval status (pending first within groups)

### Visual Indicators
- Completed suggestions: 50% opacity
- Disabled vote buttons for completed suggestions
- Correct tag badges
- Proper filter counts

### Edge Cases Handled
- Zero vote suggestions
- Identical vote counts
- Missing tags
- Mixed approval statuses

## Test Data Cleanup

After testing:
1. Delete test suggestions via admin interface
2. Delete test app via admin interface
3. Verify no orphaned data remains

## Troubleshooting

### Common Issues
1. **Suggestions not sorting**: Check browser cache, refresh page
2. **Wrong order**: Verify tag values exactly match "ist umgesetzt"
3. **Vote buttons enabled on completed**: Check frontend JavaScript logic
4. **Admin sorting different**: Verify admin-specific sorting logic

### Debug Steps
1. Check browser console for JavaScript errors
2. Verify API responses using browser dev tools
3. Check Firestore data for correct tag values
4. Test with different user sessions to rule out caching

## Success Criteria

✅ All open suggestions appear before completed ones
✅ Within each group, sorting by vote count works correctly  
✅ Vote counts are preserved and accurate
✅ Visual indicators (opacity, disabled buttons) work correctly
✅ Admin interface maintains same sorting with additional approval logic
✅ Tag changes immediately affect sorting order
✅ Filters work correctly and maintain sorting within filtered results
✅ API endpoints return correctly sorted data
✅ No JavaScript errors in browser console
✅ Responsive design works on mobile devices

## Test Report Template

```
Test Date: ___________
Tester: ___________
Environment: ___________

Test Results:
- Test 1 (Main Interface): ✅/❌
- Test 2 (Admin Interface): ✅/❌  
- Test 3 (Dynamic Sorting): ✅/❌
- Test 4 (Filter Interaction): ✅/❌
- Test 5 (API Testing): ✅/❌

Issues Found:
1. _________________________
2. _________________________

Recommendations:
1. _________________________
2. _________________________

Overall Status: ✅ PASS / ❌ FAIL
```