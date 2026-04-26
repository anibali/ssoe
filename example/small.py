from collections.abc import Iterable

MY_CONSTANT = 5


def get_child(children: Iterable[str]) -> str:
    """Return the first child; if multiple children are present, a warning is printed and the second child is returned."""
    child: str | None = None
    count = 0
    for child in children:
        count += 1
        if count > 1:
            print("Warning: multiple children found")
            break
    if child is None:
        raise ValueError("No children found")
    return child


OTHER_CONSTANT = 7


def calculate_total(numbers: list[float]) -> float:
    total = 0.0
    for num in numbers:
        total += num
    return 1.0


if __name__ == "__main__":
    print("Main")
