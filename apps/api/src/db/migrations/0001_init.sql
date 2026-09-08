-- Initial schema for the MySQL migration off Firestore.
-- All ids are CHAR(36) UUIDs (generated server-side, mirrors Firestore doc ids being
-- opaque strings). Photos stay as base64 data URLs in LONGTEXT columns, per the user's
-- explicit decision not to build a filesystem/S3 upload pipeline.

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(191) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'staff') NOT NULL DEFAULT 'staff',
  name VARCHAR(191) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customers (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(191) NULL,
  phone VARCHAR(32) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_customers_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vehicles (
  id CHAR(36) NOT NULL PRIMARY KEY,
  customer_id CHAR(36) NOT NULL,
  plate VARCHAR(32) NOT NULL,
  province VARCHAR(64) NULL,
  brand VARCHAR(64) NOT NULL,
  model VARCHAR(128) NOT NULL,
  year VARCHAR(16) NULL,
  color VARCHAR(64) NULL,
  mileage VARCHAR(32) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vehicles_customer (customer_id),
  INDEX idx_vehicles_plate (plate),
  CONSTRAINT fk_vehicles_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jobs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  job_number VARCHAR(32) NOT NULL,
  queue_no VARCHAR(16) NULL,
  vehicle_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  mileage_in VARCHAR(32) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'received',
  technician VARCHAR(191) NULL,
  bay VARCHAR(32) NULL,
  appointment_date DATETIME NULL,
  price_estimate VARCHAR(32) NULL,
  discount_type ENUM('amount', 'percent') NULL,
  discount_value VARCHAR(32) NULL,
  est_value VARCHAR(32) NULL,
  est_unit ENUM('minute', 'hour', 'day') NULL,
  warranty_days INT NULL,
  signature_inspector LONGTEXT NULL,
  signature_quoter LONGTEXT NULL,
  signature_customer LONGTEXT NULL,
  thumb LONGTEXT NULL,
  photo_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  deleted_by VARCHAR(191) NULL,
  UNIQUE KEY uq_jobs_job_number (job_number),
  INDEX idx_jobs_vehicle (vehicle_id),
  INDEX idx_jobs_customer (customer_id),
  INDEX idx_jobs_status (status),
  INDEX idx_jobs_created_at (created_at),
  INDEX idx_jobs_deleted_at (deleted_at),
  CONSTRAINT fk_jobs_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_jobs_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_status_history (
  id CHAR(36) NOT NULL PRIMARY KEY,
  job_id CHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL,
  changed_at DATETIME(3) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_job_status_history_job (job_id),
  CONSTRAINT fk_job_status_history_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_technician_history (
  id CHAR(36) NOT NULL PRIMARY KEY,
  job_id CHAR(36) NOT NULL,
  name VARCHAR(191) NOT NULL,
  changed_at DATETIME(3) NOT NULL,
  changed_by VARCHAR(191) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_job_technician_history_job (job_id),
  CONSTRAINT fk_job_technician_history_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_complaints (
  id CHAR(36) NOT NULL PRIMARY KEY,
  job_id CHAR(36) NOT NULL,
  text TEXT NOT NULL,
  custom TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_job_complaints_job (job_id),
  CONSTRAINT fk_job_complaints_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_parts_needed (
  id CHAR(36) NOT NULL PRIMARY KEY,
  job_id CHAR(36) NOT NULL,
  name VARCHAR(191) NOT NULL,
  qty VARCHAR(32) NULL,
  unit VARCHAR(32) NULL,
  price VARCHAR(32) NULL,
  brand VARCHAR(191) NULL,
  note TEXT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_job_parts_needed_job (job_id),
  CONSTRAINT fk_job_parts_needed_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_part_photos (
  id CHAR(36) NOT NULL PRIMARY KEY,
  part_id CHAR(36) NOT NULL,
  photo LONGTEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_job_part_photos_part (part_id),
  CONSTRAINT fk_job_part_photos_part FOREIGN KEY (part_id) REFERENCES job_parts_needed(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_notes (
  id CHAR(36) NOT NULL PRIMARY KEY,
  job_id CHAR(36) NOT NULL,
  text TEXT NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `by` VARCHAR(191) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_job_notes_job (job_id),
  CONSTRAINT fk_job_notes_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS master_parts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  category VARCHAR(191) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_master_parts_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vehicle_models (
  id CHAR(36) NOT NULL PRIMARY KEY,
  brand VARCHAR(64) NOT NULL,
  name VARCHAR(191) NOT NULL,
  year_range VARCHAR(64) NULL,
  seed_key VARCHAR(191) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vehicle_models_brand (brand)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS model_parts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  model_id CHAR(36) NOT NULL,
  part_name VARCHAR(191) NOT NULL,
  category VARCHAR(191) NULL,
  qty VARCHAR(32) NULL,
  unit VARCHAR(32) NULL,
  variant VARCHAR(191) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_model_parts_model (model_id),
  CONSTRAINT fk_model_parts_model FOREIGN KEY (model_id) REFERENCES vehicle_models(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS model_part_brands (
  id CHAR(36) NOT NULL PRIMARY KEY,
  model_part_id CHAR(36) NOT NULL,
  name VARCHAR(191) NOT NULL,
  price VARCHAR(32) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_model_part_brands_part (model_part_id),
  CONSTRAINT fk_model_part_brands_part FOREIGN KEY (model_part_id) REFERENCES model_parts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS promotions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  model_id CHAR(36) NOT NULL,
  name VARCHAR(191) NOT NULL,
  price VARCHAR(32) NULL,
  date_start DATE NULL,
  date_end DATE NULL,
  mileage_start VARCHAR(32) NULL,
  mileage_end VARCHAR(32) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_promotions_model (model_id),
  CONSTRAINT fk_promotions_model FOREIGN KEY (model_id) REFERENCES vehicle_models(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS promotion_items (
  id CHAR(36) NOT NULL PRIMARY KEY,
  promotion_id CHAR(36) NOT NULL,
  item_id VARCHAR(191) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_promotion_items_promotion (promotion_id),
  CONSTRAINT fk_promotion_items_promotion FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ShopConfig singleton: a single row with id=1, seeded below.
CREATE TABLE IF NOT EXISTS shop_config (
  id TINYINT NOT NULL PRIMARY KEY,
  shop_name VARCHAR(191) NOT NULL DEFAULT '',
  shop_sub VARCHAR(191) NOT NULL DEFAULT '',
  shop_phone VARCHAR(64) NOT NULL DEFAULT '',
  shop_line VARCHAR(191) NOT NULL DEFAULT '',
  shop_site VARCHAR(191) NOT NULL DEFAULT '',
  ai_api_key LONGTEXT NULL,
  gemini_api_key LONGTEXT NULL,
  ai_model ENUM('claude', 'gemini') NOT NULL DEFAULT 'claude',
  theme_id VARCHAR(64) NOT NULL DEFAULT 'default',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO shop_config (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;

CREATE TABLE IF NOT EXISTS technicians (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS deleted_master_part_names (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  UNIQUE KEY uq_deleted_master_part_names_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
