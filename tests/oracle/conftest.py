def pytest_configure(config) -> None:
    config.addinivalue_line(
        "markers", "slow: long-running oracle checks (deselect with -m 'not slow')"
    )
