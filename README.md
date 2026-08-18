# TBI-MCE Task Management System

**Technology Business Incubator – Malnad College of Engineering, Hassan**

A complete web-based Task Management and Monitoring System with Google Sheets as the backend database.

---

## Features

- **Role-based Access** — Admin (CEO/COO) and Employee views
- **Google Sheets Backend** — Live read/write via Google Sheets API
- **Task Lifecycle** — Create → Assign → Track → Submit → Approve/Reject
- **Analytics Dashboard** — Charts, KPIs, Employee Ranking
- **Reports** — Daily/Weekly/Monthly + Excel & PDF export
- **Dark Mode** — Toggle dark/light theme
- **Notifications** — Real-time task alerts
- **Mobile Responsive** — Bootstrap 5 layout

---

## Tech Stack

| Layer     | Technology                        |
|-----------|-----------------------------------|
| Frontend  | HTML5, CSS3, Bootstrap 5, JS      |
| Backend   | PHP 8.x                           |
| Database  | Google Sheets API (Primary)       |
| Charts    | Chart.js 4                        |
| Export    | SheetJS (Excel) + jsPDF (PDF)     |
| Email     | PHPMailer + Gmail SMTP            |

---

## Hostinger + MySQL Setup (recommended for live hosting)

The app ships with three interchangeable storage backends behind one API —
**MySQL**, Google Sheets, and a zero-config JSON-file store. It auto-selects
MySQL as soon as you provide credentials; until then it keeps using the JSON
files, so nothing breaks before you configure the database. No front-end or API
changes are needed — every dashboard reads and writes the same database, so they
all stay in sync.

1. **Create the database** — hPanel → *Databases → MySQL Databases*. Create a
   database and a user, then attach the user to the database. Note the full
   database name, user, and password (host is `localhost` on Hostinger).

2. **Add credentials** — copy `config/database.sample.php` to
   `config/database.php` and fill in those four values. This file is gitignored,
   so your password is never committed.

3. **Create tables + import existing data** — visit once in a browser:
   ```
   https://YOUR-DOMAIN/setup/migrate_to_mysql.php?key=TBI_SETUP_2024
   ```
   (`TBI_SETUP_2024` is the default `SETUP_KEY` in `config/config.php` — change
   it for production.) This creates one table per entity and imports the current
   `data/*.json` records. It is safe to re-run.

4. **Lock it down** — delete or block `setup/migrate_to_mysql.php` afterwards.

That's it — the app is now backed by MySQL. Each entity is a table with a real
column per field plus an `extra_json` catch-all, so no data is ever dropped.

---

## Quick Setup

### Prerequisites
- PHP 8.0+
- Composer
- Apache/Nginx with mod_rewrite
- Google Cloud Account

---

### Step 1 — Install Dependencies

```bash
cd tbi_task_manager
composer install
```

---

### Step 2 — Google Sheets Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → Enable **Google Sheets API**
3. Go to **Credentials** → **Create Service Account**
4. Download the JSON key → rename to `credentials.json` → place in `config/`
5. Create a new **Google Sheet** in your Google Drive
6. Copy the **Spreadsheet ID** from the URL: `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_HERE/edit`
7. **Share** the spreadsheet with the service account email (from credentials.json `client_email`) — give **Editor** access

---

### Step 3 — Configure

Edit `config/config.php`:

```php
define('SPREADSHEET_ID', 'YOUR_SPREADSHEET_ID_HERE');
define('BASE_URL',       '/tbi_task_manager');   // adjust to your web path
```

For email (forgot password):
```php
define('SMTP_USER', 'your-gmail@gmail.com');
define('SMTP_PASS', 'your-16-char-app-password');
```
> Use a Gmail **App Password** (not your regular password). Enable 2FA first.

---

### Step 4 — Initialize Sheets

Visit in browser (run once):
```
http://localhost/tbi_task_manager/setup/setup_sheets.php?key=TBI_SETUP_2024
```

Or via CLI:
```bash
php setup/setup_sheets.php
```

This creates all sheets, headers, 6 sample employees, sample tasks, and login accounts.

> **IMPORTANT:** After running, restrict access to the setup file or delete it.

---

### Step 5 — Web Server

**Apache** — ensure `mod_rewrite` is enabled and `AllowOverride All` is set.

**Nginx** — add to your server block:
```nginx
location /tbi_task_manager {
    try_files $uri $uri/ /tbi_task_manager/index.php?$query_string;
}
```

---

## Login Credentials (after setup)

| Role     | Username | Password      |
|----------|----------|---------------|
| Admin    | admin    | (set by admin)     |
| CEO      | rajesh   | (set by admin)     |
| COO      | priya    | (set by admin)     |
| Employee | arun     | (set by admin)  |
| Employee | kavya    | (set by admin)  |
| Employee | suresh   | (set by admin)  |
| Employee | mahesh   | (set by admin)  |

> Change all passwords immediately after first login.

---

## Google Sheets Structure

| Sheet Name    | Columns |
|---------------|---------|
| Employees     | Employee_ID, Name, Designation, Email, Phone, Photo_URL, Status |
| Tasks         | Task_ID, Employee_ID, Task_Title, Description, Priority, Assigned_Date, Deadline, Status, Days_Pending, Assigned_By, File_URL, Notes |
| Approvals     | Approval_ID, Task_ID, Employee_ID, Status, Approved_By, Comments, Approval_Date, Submission_Date |
| Users         | User_ID, Username, Password_Hash, Designation, Employee_ID, Email, Name, Reset_Token, Reset_Expiry |
| Notifications | Notif_ID, User_ID, Message, Type, Read_Status, Created_At |

---

## Project Structure

```
tbi_task_manager/
├── index.php                  Login page
├── logout.php
├── forgot_password.php
├── reset_password.php
├── dashboard.php              Role-based redirect
├── config/
│   ├── config.php             ← Edit this!
│   └── credentials.json       ← Google service account key
├── api/
│   ├── GoogleSheetsService.php
│   └── notifications_api.php
├── admin/
│   ├── dashboard.php          Admin home with employee cards
│   ├── tasks.php              Task list + filters
│   ├── create_task.php        Create/Edit task
│   ├── employees.php          Employee management
│   ├── approvals.php          Approval workflow
│   ├── analytics.php          Charts & KPIs
│   └── reports.php            Reports + Export
├── employee/
│   ├── dashboard.php          Employee home
│   ├── tasks.php              Task list + status update
│   └── profile.php            Profile + password change
├── includes/
│   ├── functions.php
│   ├── auth_check.php
│   ├── admin_check.php
│   ├── header.php
│   └── footer.php
├── assets/
│   ├── css/style.css
│   ├── js/main.js
│   └── images/logo.png        ← Add TBI logo here
├── uploads/                   File attachments
├── setup/
│   └── setup_sheets.php
└── composer.json
```

---

## Adding TBI Logo

Place the TBI-MCE logo image at:
```
assets/images/logo.png
```
Recommended size: 80×80 px PNG with transparent background.

---

## Security Notes

- Passwords are stored as **bcrypt hashes** in Google Sheets
- CSRF tokens protect all forms
- Sessions expire after 2 hours of inactivity
- HTTP security headers are set via `.htaccess`
- `credentials.json` and `vendor/` are blocked by `.htaccess`
- Never commit `credentials.json` to version control

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Blank page | Check PHP error log; enable `display_errors` temporarily |
| Sheets not updating | Verify service account has Editor access to the sheet |
| Login fails | Run setup script again; check `Users` sheet has data |
| Email not sending | Use Gmail App Password, not account password |
| Charts blank | Check browser console for JS errors |

---

*Built for Technology Business Incubator – Malnad College of Engineering, Hassan*
