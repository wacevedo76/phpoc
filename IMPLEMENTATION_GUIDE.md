# Implementation Guide: Adding Logging to PH Command

## Step-by-Step Integration

### Step 1: Review Current Architecture

First, understand the existing PH command structure:

```
personal_history/ph/
├── v001/
│   ├── views/
│   │   └── cli_view.py          # CLI interface
│   ├── controllers/
│   │   ├── history_controller.py
│   │   ├── time_tracking_controller.py
│   │   └── validation_controller.py
│   └── models/                  # Data structures
└── logging_module.py            # New logging module
```

### Step 2: Choose Integration Method

#### Option A: Minimal Integration (Quick Start)
Patch the existing CLI view with minimal changes:

```python
# In your main.py or __main__.py
from ph.logging_integration import patch_existing_cli
from ph.v001.views.cli_view import main

# Patch before running
patch_existing_cli()

# Run the CLI
main()
```

#### Option B: Full Integration (Recommended)
Create a new entry point with comprehensive logging:

```python
# ph_logged.py - New entry point
#!/usr/bin/env python3
"""PH Command with Logging"""

from ph.logging_integration import LoggingCLIEntryPoint

if __name__ == "__main__":
    LoggingCLIEntryPoint.main()
```

#### Option C: Custom Integration
Integrate logging selectively into specific components:

```python
from ph.logging_module import get_logger, log_operation
from ph.v001.controllers.history_controller import HistoryController

# Create logged version of specific methods
class LoggedHistoryController(HistoryController):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.logger = get_logger()
    
    @log_operation("create_activity", get_logger())
    def create_activity(self, activity_type, data, duration, shareable=True):
        return super().create_activity(activity_type, data, duration, shareable)
```

### Step 3: Update the CLI Entry Point

Modify the main CLI entry point to use logging:

```python
# Current: ph/v001/views/cli_view.py
def main():
    """Main CLI entry point"""
    cli = CLIView()
    cli.run()

# Updated with logging:
def main():
    """Main CLI entry point with logging"""
    from ..logging_integration import create_logging_integrated_cli
    
    cli = create_logging_integrated_cli()
    cli.run()
```

### Step 4: Test the Integration

Run the test suite to verify logging works:

```bash
cd /home/openclaw/.openclaw/workspace/personal_history
python test_logging.py
```

Test actual PH commands with logging:

```bash
# Test without logging (original)
python -m ph.v001.views.cli_view init --name "Test"

# Test with logging (new)
python ph_logged.py init --name "Test"
```

### Step 5: Verify Log Output

Check that logs are being created:

```bash
# Check log directory
ls -la ~/.personal_history/logs/

# View recent logs
tail -f ~/.personal_history/logs/ph_202403.log

# View structured logs
tail -f ~/.personal_history/logs/ph_structured_202403.log | jq .
```

### Step 6: Add Logging to Specific Operations

Identify key operations that need detailed logging:

1. **Command execution** - Already handled by decorators
2. **File operations** - Add to `sync_to_file`, `save_identity`, etc.
3. **Validation errors** - Add to validation controller
4. **Timer operations** - Add to time tracking controller

Example for time tracking:

```python
# In time_tracking_controller.py
from ..logging_module import log_operation, get_logger

class TimeTrackingController:
    @log_operation("start_timer", get_logger())
    def start_timer(self, activity_name, activity_type=None, data=None):
        # Existing code
        pass
    
    @log_operation("stop_timer", get_logger())
    def stop_timer(self, activity_name):
        # Existing code
        pass
```

### Step 7: Configure Log Rotation (Optional)

For production use, configure log rotation:

```python
# Advanced configuration
import logging
from logging.handlers import RotatingFileHandler
from ph.logging_module import PHLogger

class ProductionLogger(PHLogger):
    def _setup_logging(self, level):
        # Custom setup with rotation
        handler = RotatingFileHandler(
            self.log_dir / "ph.log",
            maxBytes=10*1024*1024,  # 10MB
            backupCount=5
        )
        # ... rest of setup
```

### Step 8: Monitor and Analyze Logs

Set up regular log analysis:

```python
# Daily log analysis script
#!/usr/bin/env python3
"""Daily log analysis"""

from ph.logging_integration import analyze_logs
import json

# Analyze yesterday's logs
analysis = analyze_logs(1)

# Save report
with open("daily_log_report.json", "w") as f:
    json.dump(analysis, f, indent=2)

# Check for issues
if analysis["summary"]["error_count"] > 0:
    print(f"⚠️  Found {analysis['summary']['error_count']} errors")
    # Send alert, etc.
```

## Common Integration Patterns

### Pattern 1: Method-Level Logging

```python
from ph.logging_module import log_operation

class MyController:
    @log_operation("my_operation", get_logger())
    def my_method(self, arg1, arg2):
        # Method logic
        pass
```

### Pattern 2: Block-Level Logging

```python
from ph.logging_module import LoggingContext

def complex_operation():
    with LoggingContext("complex_operation", get_logger()):
        # Multiple steps, all logged as one operation
        step1()
        step2()
        step3()
```

### Pattern 3: Conditional Logging

```python
def sensitive_operation(debug=False):
    if debug:
        with LoggingContext("sensitive_operation", get_logger()):
            return do_sensitive_work()
    else:
        # No logging for privacy
        return do_sensitive_work()
```

### Pattern 4: Error-Specific Logging

```python
from ph.logging_module import get_logger

logger = get_logger()

try:
    risky_operation()
except ValueError as e:
    logger.log_error("ValidationError", str(e), {"context": "risky_operation"})
    raise
except Exception as e:
    logger.log_error("UnexpectedError", str(e), {"context": "risky_operation"})
    raise
```

## Testing the Integration

### Unit Tests

```python
# test_logging_integration.py
import unittest
from unittest.mock import Mock, patch
from ph.logging_integration import LoggingHistoryController

class TestLoggingIntegration(unittest.TestCase):
    def test_controller_logging(self):
        mock_controller = Mock()
        logging_controller = LoggingHistoryController(mock_controller)
        
        # Test that methods are logged
        logging_controller.create_identity("Test")
        self.assertTrue(mock_controller.create_identity.called)
```

### Integration Tests

```python
# test_full_integration.py
import subprocess
import tempfile
from pathlib import Path

def test_cli_with_logging():
    """Test that CLI commands produce logs"""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Run a command
        result = subprocess.run(
            ["python", "ph_logged.py", "init", "--name", "Test"],
            cwd=tmpdir,
            capture_output=True,
            text=True
        )
        
        # Check logs were created
        log_dir = Path(tmpdir) / ".personal_history" / "logs"
        assert log_dir.exists()
        assert any(log_dir.glob("*.log"))
```

### Performance Tests

```python
# test_performance.py
import time
from ph.logging_module import get_logger

def test_logging_performance():
    """Ensure logging doesn't significantly impact performance"""
    logger = get_logger(level="INFO")
    
    start = time.time()
    for i in range(1000):
        logger.log_operation(f"test_{i}", {"iteration": i})
    
    duration = time.time() - start
    assert duration < 1.0  # Should complete in under 1 second
```

## Deployment Considerations

### Development Environment
- Use `level="DEBUG"` for detailed logs
- Log to console for immediate feedback
- Enable all log types for comprehensive testing

### Production Environment
- Use `level="INFO"` or `level="WARNING"`
- Log to files with rotation
- Disable console logging for background operations
- Monitor log file sizes

### Security Considerations
1. **Never log sensitive data** (passwords, tokens, personal information)
2. **Set appropriate file permissions** on log directories
3. **Regularly review and purge old logs**
4. **Consider encryption for sensitive environments**

## Maintenance Tasks

### Regular Maintenance
1. **Weekly**: Review error logs and address common issues
2. **Monthly**: Rotate log files and archive old logs
3. **Quarterly**: Review logging configuration and adjust levels
4. **Annually**: Audit log retention policies

### Troubleshooting Checklist
- [ ] Logs not appearing? Check log level and directory permissions
- [ ] Performance issues? Consider raising log level or adding filters
- [ ] Disk space full? Implement log rotation or archiving
- [ ] Logs unreadable? Check encoding and formatting

## Example: Complete Integration

Here's a complete example of integrating logging into the PH command:

```python
# ph/__main__.py - Updated main entry point
#!/usr/bin/env python3
"""PH Command Main Entry Point with Logging"""

import sys
from pathlib import Path

# Add project to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from ph.logging_integration import LoggingCLIEntryPoint

if __name__ == "__main__":
    LoggingCLIEntryPoint.main()
```

Update setup.py to use the new entry point:

```python
# setup.py
entry_points={
    'console_scripts': [
        'ph=ph.__main__:main',  # Changed from cli_view:main
    ],
}
```

## Next Steps

After successful integration:

1. **Monitor usage patterns** from logs
2. **Identify common errors** and fix them
3. **Optimize performance** based on timing logs
4. **Add custom metrics** for your specific use cases
5. **Set up alerts** for critical errors

## Support

For integration issues:
1. Run the test suite: `python test_logging.py`
2. Check example integrations in `logging_integration.py`
3. Review the logging module documentation
4. Examine generated log files for clues

---

*Implementation Guide v1.0 - March 31, 2026*