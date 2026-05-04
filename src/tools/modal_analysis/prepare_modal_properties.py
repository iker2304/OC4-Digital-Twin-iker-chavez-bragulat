#!/usr/bin/env python3
"""
Modal Properties File Formatter
Converts the modal properties table into JSON format for the main script
"""

import json
from pathlib import Path

def create_modal_properties_from_table():
    """
    This script helps you prepare the modal_properties.json file
    
    You have the table with:
    Mode  Freq [Hz]   Mass_x [Kg]  Mass_x [%]  Mass_y [Kg]  Mass_y [%]  Mass_z [Kg]  Mass_z [%]
    
    Simply paste the data into a text file named 'modal_data_table.txt'
    and this script will convert it to the required format.
    """
    
    # For now, create a sample based on the data you provided
    # You can modify these values with your actual data
    
    modal_data = """Mode  Freq [Hz]   Mass_x [Kg]  Mass_x [%]  Mass_y [Kg]  Mass_y [%]  Mass_z [Kg]  Mass_z [%]
   8            0.00048589083  0.010022218   0.16104582 0.0022797302   0.03663271 3.3615166e-05   0.00054016
   9 0.00065277834 0.0063673808   0.10231668 0.00054527588   0.00876197 0.0058884423   0.09462068
  10 0.00071340497  0.013661693   0.21952811 0.0086516907   0.13902298  0.012221485   0.19638558
  11 0.00094358895 0.0004645608   0.00746497 3.7369623e-05   0.00060049  0.015346153   0.24659550
  12 0.0011270073 0.0031510581   0.05063398 0.0039656119   0.06372294 1.8027675e-05   0.00028968
  13   0.51016218    1.2034977  19.33886052 9.5783415e-09   0.00000015 1.6350238e-12   0.00000000
  14   0.57102355 9.1699966e-09   0.00000015   0.94773983  15.22911785 0.00083438139   0.01340757
  15    2.0455239     1.677279  26.95199566 8.1852328e-10   0.00000001 5.8423406e-10   0.00000001
  16    2.5683071 1.1008242e-08   0.00000018    1.4845912  23.85571829  0.088641208   1.42436497
  20    4.3765593 2.5741135e-07   0.00000414 0.00021500671   0.00345492    1.7366628  27.90622672
  27    10.892162  0.011489505   0.18462348 8.6872135e-06   0.00013959 7.7517885e-07   0.00001246
"""
    
    # Parse the data
    output_file = Path("modal_properties.txt")
    with open(output_file, 'w') as f:
        f.write(modal_data)
    
    print(f"Created {output_file}")
    print("This file should be used as input to generate_simulation_data.py")


def format_table_to_json():
    """
    Alternative: Convert the table data directly to JSON
    """
    # This is the data you provided, reformatted
    modes_data = {
        8: {"freq_hz": 0.00048589083, "mass_x": 0.010022218, "mass_y": 0.0022797302, "mass_z": 3.3615166e-05},
        9: {"freq_hz": 0.00065277834, "mass_x": 0.0063673808, "mass_y": 0.00054527588, "mass_z": 0.0058884423},
        10: {"freq_hz": 0.00071340497, "mass_x": 0.013661693, "mass_y": 0.0086516907, "mass_z": 0.012221485},
        11: {"freq_hz": 0.00094358895, "mass_x": 0.0004645608, "mass_y": 3.7369623e-05, "mass_z": 0.015346153},
        12: {"freq_hz": 0.0011270073, "mass_x": 0.0031510581, "mass_y": 0.0039656119, "mass_z": 1.8027675e-05},
        13: {"freq_hz": 0.51016218, "mass_x": 1.2034977, "mass_y": 9.5783415e-09, "mass_z": 1.6350238e-12},
        14: {"freq_hz": 0.57102355, "mass_x": 9.1699966e-09, "mass_y": 0.94773983, "mass_z": 0.00083438139},
        15: {"freq_hz": 2.0455239, "mass_x": 1.677279, "mass_y": 8.1852328e-10, "mass_z": 5.8423406e-10},
        16: {"freq_hz": 2.5683071, "mass_x": 1.1008242e-08, "mass_y": 1.4845912, "mass_z": 0.088641208},
        20: {"freq_hz": 4.3765593, "mass_x": 2.5741135e-07, "mass_y": 0.00021500671, "mass_z": 1.7366628},
        27: {"freq_hz": 10.892162, "mass_x": 0.011489505, "mass_y": 8.6872135e-06, "mass_z": 7.7517885e-07},
    }
    
    return modes_data


if __name__ == "__main__":
    print("Modal Properties File Formatter\n")
    print("Two options:\n")
    print("1. Generate text table:")
    create_modal_properties_from_table()
    print("\n2. Save as JSON:")
    
    data = format_table_to_json()
    output_json = Path("modal_properties.json")
    
    # Save in the format expected by the main script
    formatted_output = {}
    for mode_id, props in data.items():
        # Convert to the table format expected by main script
        formatted_output[mode_id] = f"{mode_id} {props['freq_hz']} {props['mass_x']} 0 {props['mass_y']} 0 {props['mass_z']} 0"
    
    with open(output_json, 'w') as f:
        json.dump(formatted_output, f, indent=2)
    
    print(f"Saved to {output_json}\n")
    print("Next step: Run generate_simulation_data.py")
