<?php
/**
 * Canonical entity list and column order. The column order is only needed by
 * the Google Sheets driver (to map rows <-> associative records); the JSON
 * driver stores associative arrays directly.
 */

const TBI_ENTITIES = [
    'employees'     => ['Employee_ID', 'Name', 'Designation', 'Email', 'Phone', 'Photo_URL', 'Status'],
    'users'         => ['User_ID', 'Username', 'Password_Hash', 'Designation', 'Employee_ID', 'Email', 'Name'],
    'tasks'         => ['Task_ID', 'Employee_ID', 'Task_Title', 'Description', 'Priority', 'Assigned_Date', 'Deadline', 'Deadline_Time', 'Status', 'Days_Pending', 'Assigned_By', 'File_URL', 'Notes'],
    'approvals'     => ['Approval_ID', 'Task_ID', 'Employee_ID', 'Status', 'Approved_By', 'Comments', 'Approval_Date', 'Submission_Date'],
    'notifications' => ['Notif_ID', 'User_ID', 'Message', 'Type', 'Read_Status', 'Created_At'],
    'attendance'    => ['Attendance_ID', 'Employee_ID', 'Date', 'Login_Time', 'Check_In', 'Check_Out'],
];

/** Sheet tab name for an entity (capitalised). */
function tbi_sheet_name(string $entity): string {
    return ucfirst($entity);
}

/** Validate an entity name; aborts with 400 otherwise. */
function tbi_require_entity(string $entity): void {
    if (!isset(TBI_ENTITIES[$entity])) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => "Unknown entity: $entity"]);
        exit;
    }
}
